# Provider-Agnostic Grounded Social Judge — Design

**Date:** 2026-07-12
**Status:** Design (approved for spec) — pending user review before implementation plan
**Base branch:** `dev` (social M1 lives here, not `master`)

## Problem

The social-M1 "judge" decides whether an inbound intent from a paired peer matches the owner. When it can call the `wx*` plugin MCP tools (`find_facts`, `top_contacts`, …), it judges **grounded** in the owner's real WeChat facts. When it can't, it falls back to `cheapEval` — a one-shot with **no tools**, so it can only do topic/keyword-level matching.

Today grounded judging is gated to a single provider:

```ts
// src/daemon/bootstrap/index.ts:1336
if (defaultProviderId === 'openai' && socialOpenaiKey && configuredAgent.openaiBaseUrl && configuredAgent.openaiModel) {
  socialRunTurn = /* spawn a plugin-grounded openai judge session */
} else {
  socialRunTurn = (sys, usr) => socialCheapEval(`${sys}\n\n${usr}`)   // ungrounded
}
```

So grounded judging only works when the daemon's **default** provider is openai/Kimi. On a Claude-default daemon (the common case, and the current live setup), social judging silently degrades to ungrounded — producing lower-quality matches — even though the Claude bot already carries the same `wx*` tools.

### Why this is the wrong constraint

End users pick a provider based on what they have (a Claude subscription, a Kimi API key); they neither know nor should manage a "judge provider." Grounded judging must work **regardless of which provider the user picked**, with **zero extra configuration**. Forcing the whole daemon onto Kimi (option "unify") or adding a judge-specific provider knob (option "parallel config") both push provider mechanics onto the user and are rejected.

### Why it's cheap to fix

The plugin-tool-carrying capability is **not** openai-exclusive. Every provider's main session is already built with `...pluginMcp` in its MCP servers:

| Provider | Plugin MCP injection | Ref |
|---|---|---|
| claude | `mcpServers` factory opt (`pluginMcpForClaude`) | `bootstrap/index.ts:665` |
| codex | `mcpServers` factory opt | `:845` |
| cursor | `mcpServers` factory opt | `:921` |
| gemini | self-driven loop + MCP client (`McpPort`) | `gemini-agent-provider.ts:96,351` |
| openai | self-driven loop + MCP bridge | `:984` |

The judge tier (`SOCIAL_JUDGE_PROFILE`, `user-tier.ts:126`), the spawn context shape, `collectTurn` (`agent-provider.ts:337`), and everything downstream (`makeJudge → makeAnswerIntent → onIntent`, `core/social-judge.ts`) are **already provider-agnostic**. Only the *construction* of `socialRunTurn` is openai-specific. This design generalizes exactly that one construction.

## Goal

Grounded social judging works on any default provider. Ship **Claude + openai** now (Claude is the live provider; openai is a no-behavior-change refactor of the existing path). `codex`/`cursor`/`gemini` slot in behind the same seam as follow-ons.

## Design

### New unit: `src/daemon/social/grounded-judge.ts`

Extract the judge `runTurn` construction out of the already-oversized `bootstrap/index.ts` into a focused, testable module.

**Public surface:**

```ts
export interface GroundedJudgeDeps {
  providerId: ProviderId            // the daemon's default provider
  pluginMcp: Record<string, McpStdioSpec>   // plugins-only MCP specs (NO wechat/delegate)
  stateDir: string
  log: (tag: string, msg: string) => void
  // provider-construction inputs, read from configuredAgent/env by the caller:
  openai?: { apiKey: string; baseUrl: string; model: string }
  claude?: { model?: string }   // configuredAgent.model; other claude factory
                                // inputs mirror the main provider (bootstrap:662)
}

/**
 * Returns a runTurn that spawns a constrained, plugin-grounded judge session
 * on `providerId`, or `null` when no grounded adapter exists for that provider
 * (or its required config is absent). `null` ⇒ caller falls back to cheapEval.
 */
export function makeGroundedJudgeRunTurn(
  deps: GroundedJudgeDeps,
): ((systemPrompt: string, userPrompt: string) => Promise<string>) | null
```

**Internal structure — two parts:**

1. **`buildJudgeProvider(deps): AgentProvider | null`** — the *only* provider-specific code. Constructs a provider instance whose MCP servers are **plugins-only**:
   - `openai`: existing path — `createOpenAiAgentProvider({ makeMcpBridge: … buildOpenaiMcpSpecs({ wechat: null, delegate: null, pluginMcp }) })`.
   - `claude`: `createClaudeAgentProvider({ mcpServers: <plugins formatted as `{ type: 'stdio', ...spec }` per bootstrap:606-607>, model: deps.claude?.model, … })` — same factory the main Claude bot uses, but with **only** the plugin servers (no `wechat`, no `delegate`).
   - any other providerId → `return null`.
2. **The shared `runTurn` closure** (identical for every provider — lifted verbatim from today's openai path):

```ts
const runTurn = async (systemPrompt, userPrompt) => {
  let session = null
  try {
    session = await provider.spawn(
      { alias: '_social_judge', path: deps.stateDir },
      {
        tierProfile: SOCIAL_JUDGE_PROFILE,   // allow: ['plugin_tool'] ONLY
        permissionMode: 'strict',
        chatId: '_social_judge',
        appendInstructions: systemPrompt,
      },
    )
    const result = await collectTurn(session.dispatch(userPrompt))
    return result.assistantText.join('')
  } finally {
    if (session) { try { await session.close() } catch { /* swallow */ } }
  }
}
```

Session lifecycle stays **per-call spawn+close** (fresh `_social_judge` session per intent, closed in `finally`) — matches today's openai path; no shared long-lived judge session.

### Bootstrap change (`src/daemon/bootstrap/index.ts`)

Replace the inline `if (defaultProviderId === 'openai') {…} else {cheapEval}` block (~lines 1335–1384) with:

```ts
const groundedRunTurn = makeGroundedJudgeRunTurn({
  providerId: defaultProviderId,
  pluginMcp,
  stateDir: deps.stateDir,
  log: deps.log,
  openai: (socialOpenaiKey && configuredAgent.openaiBaseUrl && configuredAgent.openaiModel)
    ? { apiKey: socialOpenaiKey, baseUrl: configuredAgent.openaiBaseUrl, model: configuredAgent.openaiModel } : undefined,
  claude: { model: configuredAgent.model },
})
const socialRunTurn = groundedRunTurn
  ?? (async (systemPrompt, userPrompt) => socialCheapEval(`${systemPrompt}\n\n${userPrompt}`))
deps.log('BOOT', groundedRunTurn
  ? `social: plugin-grounded judge via ${defaultProviderId} (pluginMcp only, no wechat/delegate)`
  : `social: grounded judging unavailable for provider=${defaultProviderId} — judge falls back to cheapEval (no tools)`)
```

`makeJudge({ runTurn: socialRunTurn, policy })` and everything after are unchanged.

## Security invariant (unchanged, now enforced per adapter)

The judge session MUST get, on every provider:
- **plugins-only MCP** — never `wechat` (could send-as-owner) or `delegate` (could recurse). Each `buildJudgeProvider` branch passes only `pluginMcp`.
- **`SOCIAL_JUDGE_PROFILE`** — `allow: ['plugin_tool']`, everything else denied (no Read/Write/Bash/WebFetch/subagent). Provider-neutral; Claude translates it via `tierProfileToClaudeSdkOpts`.
- **`permissionMode: 'strict'`**.

This is the same guarantee the openai path established (commit `0312b1c`). Each new adapter gets a test asserting its judge provider is constructed with plugins-only `mcpServers`.

## Error handling / degradation

- No grounded adapter for `providerId`, or required config missing → `makeGroundedJudgeRunTurn` returns `null` → caller uses `cheapEval` (ungrounded but functional). Logged at BOOT naming the provider.
- Judge spawn/dispatch throws at runtime → the existing `makeJudge`/`makeAnswerIntent` error handling applies (same as today's openai path); the intent is answered conservatively per the fail-closed disclosure policy. No change to that layer.
- `cheapEval` itself absent (no registered provider offers one) → social wiring stays inert, as today (`bootstrap/index.ts:1322`).

## Testing

- **Unit (`grounded-judge.test.ts`)**: `makeGroundedJudgeRunTurn` returns a function for `providerId: 'claude'` (with claude config) and `'openai'` (with openai config); returns `null` for `'codex'`/`'cursor'`/`'gemini'` (no adapter yet) and for `'openai'` with missing config.
- **Isolation (security)**: for both claude and openai adapters, assert the constructed judge provider's MCP servers contain the plugin servers and **neither `wechat` nor `delegate`**. Mirrors the guarantee the openai path already relies on.
- **Tier**: existing `SOCIAL_JUDGE_PROFILE` tests (`user-tier.test.ts:356+`) already assert `allow == ['plugin_tool']`; unchanged.
- **Integration (bootstrap)**: on a claude-default daemon with a loaded plugin, the social wiring selects the grounded path (assert via the BOOT log line / the seam), not cheapEval. Extends `bootstrap.test.ts`.
- **Regression**: the existing openai grounded-judge behavior and the two-agent AC1–AC5 e2e (`social-m1.e2e.test.ts`) stay green — the openai path is refactored, not changed.

## Scope

**In scope (this spec):**
- New module `daemon/social/grounded-judge.ts` with the shared `runTurn` + `openai` and `claude` adapters.
- Bootstrap refactor to use it.
- Tests above.

**Out of scope (documented follow-ons):**
- `codex`, `cursor`, `gemini` adapters. Until they land, those providers fall back to `cheapEval` (with the BOOT log naming the gap). `cursor`'s coarser tier/sandbox needs care when its adapter is written.
- Any separate "judge model" configuration — the judge reuses the default provider's configured model (YAGNI).

## Decisions (recorded)

1. **Extract to `daemon/social/grounded-judge.ts`** rather than keep inline — `bootstrap/index.ts` is a god-file; this is a clean, independently testable unit.
2. **Judge reuses the default provider's configured model** — no separate judge-model knob (YAGNI; matches the openai path today).
3. **Claude + openai now; codex/cursor/gemini are follow-ons** — Claude is the live provider and the highest-value unblock; openai is a pure refactor. The seam makes the rest mechanical.
