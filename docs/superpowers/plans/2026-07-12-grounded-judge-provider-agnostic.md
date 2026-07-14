# Provider-Agnostic Grounded Social Judge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make grounded social judging (judge reads `wx*` plugin facts) work when the daemon's default provider is Claude, not only openai — without any user-facing configuration.

**Architecture:** Extract the openai-only `socialRunTurn` construction out of `bootstrap/index.ts` into a new `src/daemon/social/grounded-judge.ts`. It exposes `makeGroundedJudgeRunTurn(deps)` returning a runTurn (or `null` → caller falls back to `cheapEval`). One shared spawn-and-collect path serves every provider; the only per-provider code is building a **plugins-only** judge `AgentProvider`. Ship the openai adapter (a pure refactor of today's code) and the claude adapter; other providers return `null` for now.

**Tech Stack:** TypeScript, Bun, Vitest. Claude Agent SDK (`@anthropic-ai/claude-agent-sdk` via `src/core/claude-agent-provider.ts`), the self-built openai loop (`src/core/openai-agent-provider.ts`).

## Global Constraints

- **Security invariant (non-negotiable):** the judge session gets **plugins-only** MCP servers — never `wechat` (send-as-owner) or `delegate` (recursion) — plus `SOCIAL_JUDGE_PROFILE` (`allow: {plugin_tool}` only) and `permissionMode: 'strict'`. This holds on every provider adapter.
- `SOCIAL_JUDGE_PROFILE` is defined in `src/core/user-tier.ts:126` (`allow` = `{plugin_tool}`, `deny` = all other kinds). Do not redefine it.
- The judge is a background call: it must **never** prompt a human (no `askUser`/relay). `SOCIAL_JUDGE_PROFILE.relay` is empty, so decisions are pure allow/deny.
- No new user-facing config. The judge reuses the default provider's already-configured model.
- `ProviderId` is `type ProviderId = string` (`src/core/conversation.ts:16`).
- Do NOT change `makeJudge`/`makeAnswerIntent`/`onIntent` (`src/core/social-judge.ts`, `bootstrap/index.ts`) — only the `socialRunTurn` they consume.
- Preserve exact behavior of the existing openai grounded path (the two-agent e2e `src/core/social-m1.e2e.test.ts` must stay green).

---

## File Structure

- **Create** `src/daemon/social/grounded-judge.ts` — `makeGroundedJudgeRunTurn(deps)`: provider dispatch + shared spawn/collect runTurn + openai adapter (Task 1) + claude adapter (Task 2).
- **Create** `src/daemon/social/grounded-judge.test.ts` — unit + isolation tests.
- **Modify** `src/core/claude-agent-provider.ts` — export `buildClaudeJudgeOptions(...)` (Task 2), keeping Claude SDK `Options`/`CanUseTool` types in this file.
- **Modify** `src/daemon/bootstrap/index.ts` — replace the inline `if (defaultProviderId === 'openai') {…} else {cheapEval}` block (~lines 1335–1384) with a `makeGroundedJudgeRunTurn` call + `cheapEval` fallback (Task 1); thread claude judge deps (Task 2).
- **Modify** `src/daemon/bootstrap.test.ts` — integration assertion that a claude-default daemon selects the grounded path (Task 2).

---

## Task 1: Shared seam + openai adapter + bootstrap swap (pure refactor)

**Files:**
- Create: `src/daemon/social/grounded-judge.ts`
- Create: `src/daemon/social/grounded-judge.test.ts`
- Modify: `src/daemon/bootstrap/index.ts:1335-1384`

**Interfaces:**
- Consumes: `createOpenAiAgentProvider` (`src/core/openai-agent-provider.ts:139`), `buildOpenaiMcpSpecs` (`src/daemon/bootstrap/mcp-specs.ts`), `SOCIAL_JUDGE_PROFILE` (`src/core/user-tier.ts:126`), `collectTurn` (`src/core/agent-provider.ts:337`), `McpStdioSpec` (`src/daemon/bootstrap/mcp-specs.ts:24`), `ProviderId` (`src/core/conversation.ts:16`).
- Produces:
  ```ts
  export interface GroundedJudgeDeps {
    providerId: ProviderId
    pluginMcp: Record<string, McpStdioSpec>
    stateDir: string
    log: (tag: string, msg: string) => void
    openai?: { apiKey: string; baseUrl: string; model: string }
    // claude added in Task 2
  }
  export type JudgeRunTurn = (systemPrompt: string, userPrompt: string) => Promise<string>
  export function makeGroundedJudgeRunTurn(deps: GroundedJudgeDeps): JudgeRunTurn | null
  ```

- [ ] **Step 1: Write the failing unit test**

Create `src/daemon/social/grounded-judge.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { makeGroundedJudgeRunTurn } from './grounded-judge'

const baseDeps = {
  pluginMcp: { wxsearch: { command: '/x', args: [], env: {} } },
  stateDir: '/tmp/x',
  log: () => {},
}

describe('makeGroundedJudgeRunTurn — provider dispatch', () => {
  it('returns a runTurn for openai when openai config is present', () => {
    const rt = makeGroundedJudgeRunTurn({
      ...baseDeps, providerId: 'openai',
      openai: { apiKey: 'k', baseUrl: 'http://x', model: 'm' },
    })
    expect(typeof rt).toBe('function')
  })

  it('returns null for openai when openai config is absent', () => {
    expect(makeGroundedJudgeRunTurn({ ...baseDeps, providerId: 'openai' })).toBeNull()
  })

  it('returns null for a provider with no adapter yet (gemini)', () => {
    expect(makeGroundedJudgeRunTurn({ ...baseDeps, providerId: 'gemini' })).toBeNull()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run test src/daemon/social/grounded-judge.test.ts`
Expected: FAIL — `Cannot find module './grounded-judge'`.

- [ ] **Step 3: Implement the module (shared path + openai adapter + dispatch)**

Create `src/daemon/social/grounded-judge.ts`:

```ts
/**
 * Provider-agnostic grounded social judge. The judge decides whether an inbound
 * intent matches the owner; "grounded" = it can call the wx* plugin MCP tools
 * to read real facts. Only the CONSTRUCTION of the judge provider is
 * provider-specific — the spawn/collect path and the SOCIAL_JUDGE_PROFILE +
 * plugins-only isolation are shared. Returns null when no grounded adapter
 * fits the provider (caller falls back to cheapEval).
 */
import type { AgentProvider } from '../../core/agent-provider'
import { collectTurn } from '../../core/agent-provider'
import type { ProviderId } from '../../core/conversation'
import { SOCIAL_JUDGE_PROFILE } from '../../core/user-tier'
import type { McpStdioSpec } from './mcp-specs'

export interface GroundedJudgeDeps {
  providerId: ProviderId
  pluginMcp: Record<string, McpStdioSpec>
  stateDir: string
  log: (tag: string, msg: string) => void
  openai?: { apiKey: string; baseUrl: string; model: string }
}

export type JudgeRunTurn = (systemPrompt: string, userPrompt: string) => Promise<string>

/**
 * Wrap a plugins-only judge provider in the shared one-shot runTurn: spawn a
 * constrained `_social_judge` session (SOCIAL_JUDGE_PROFILE + strict), dispatch
 * the userPrompt, collect assistant text, close. Fresh session per call.
 */
function runTurnVia(provider: AgentProvider, stateDir: string): JudgeRunTurn {
  return async (systemPrompt, userPrompt) => {
    let session: Awaited<ReturnType<AgentProvider['spawn']>> | null = null
    try {
      session = await provider.spawn(
        { alias: '_social_judge', path: stateDir },
        {
          tierProfile: SOCIAL_JUDGE_PROFILE,
          permissionMode: 'strict',
          chatId: '_social_judge',
          appendInstructions: systemPrompt,
        },
      )
      const result = await collectTurn(session.dispatch(userPrompt))
      return result.assistantText.join('')
    } finally {
      if (session) { try { await session.close() } catch { /* swallow shutdown errors */ } }
    }
  }
}

/** openai adapter — plugins-only, no wechat/delegate. Lifted from bootstrap. */
function buildOpenaiJudgeProvider(deps: GroundedJudgeDeps): AgentProvider | null {
  const o = deps.openai
  if (!o) return null
  // Dynamic imports mirror the original bootstrap block (keeps the openai loop
  // out of the daemon's startup path when social is off).
  return {
    async spawn(project, ctx) {
      const { createOpenAiAgentProvider } = await import('../../core/openai-agent-provider')
      const { createAiSdkChatModel } = await import('../../core/openai-chat-model')
      const { createMcpToolBridge } = await import('../../core/openai-mcp-bridge')
      const { buildOpenaiMcpSpecs } = await import('./mcp-specs')
      const provider = createOpenAiAgentProvider({
        makeChatModel: (model) => createAiSdkChatModel({ baseURL: o.baseUrl, apiKey: o.apiKey, model: model ?? o.model }),
        makeMcpBridge: async (sessionEnv) => createMcpToolBridge(
          buildOpenaiMcpSpecs({ wechat: null, delegate: null, pluginMcp: deps.pluginMcp }, sessionEnv),
        ),
        log: deps.log,
      })
      return provider.spawn(project, ctx)
    },
  }
}

export function makeGroundedJudgeRunTurn(deps: GroundedJudgeDeps): JudgeRunTurn | null {
  let provider: AgentProvider | null = null
  if (deps.providerId === 'openai') provider = buildOpenaiJudgeProvider(deps)
  // claude added in Task 2
  if (!provider) return null
  return runTurnVia(provider, deps.stateDir)
}
```

> Note: `buildOpenaiJudgeProvider` returns a thin `AgentProvider` whose `spawn` constructs the real openai provider lazily — this preserves the original code's dynamic-import behavior while fitting the shared `runTurnVia`. If the existing `createOpenAiAgentProvider` is already cheap to construct eagerly, the implementer may hoist it out of `spawn`; keep the dynamic imports either way.

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `bun run test src/daemon/social/grounded-judge.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Swap the bootstrap block**

In `src/daemon/bootstrap/index.ts`, replace the block from `let socialRunTurn: …` (line ~1335) through the `else { … cheapEval … }` (line ~1384) — everything that assigns `socialRunTurn` — with:

```ts
const { makeGroundedJudgeRunTurn } = await import('../social/grounded-judge')
const groundedRunTurn = makeGroundedJudgeRunTurn({
  providerId: defaultProviderId,
  pluginMcp,
  stateDir: deps.stateDir,
  log: deps.log,
  openai: (socialOpenaiKey && configuredAgent.openaiBaseUrl && configuredAgent.openaiModel)
    ? { apiKey: socialOpenaiKey, baseUrl: configuredAgent.openaiBaseUrl, model: configuredAgent.openaiModel }
    : undefined,
})
const socialRunTurn: (systemPrompt: string, userPrompt: string) => Promise<string> =
  groundedRunTurn ?? (async (systemPrompt, userPrompt) => socialCheapEval(`${systemPrompt}\n\n${userPrompt}`))
deps.log('BOOT', groundedRunTurn
  ? `social: plugin-grounded judge via ${defaultProviderId} (pluginMcp only, no wechat/delegate)`
  : `social: grounded judging unavailable for provider=${defaultProviderId} — judge falls back to cheapEval (no tools)`)
```

Leave the following line unchanged: `const socialJudge = makeJudge({ runTurn: socialRunTurn, policy: socialPolicy })`.
Remove now-dead locals that only the old block used (`socialJudgeBaseUrl`, `socialJudgeModel`, and the `SOCIAL_JUDGE_PROFILE` import IF no longer referenced in this file — verify with grep before deleting the import).

- [ ] **Step 6: Verify typecheck, the openai e2e, and the full suite**

Run: `bun run typecheck`
Expected: 0 errors.

Run: `bun run test src/core/social-m1.e2e.test.ts src/daemon/bootstrap.test.ts`
Expected: PASS — the openai grounded path and AC1–AC5 e2e are unchanged.

Run: `bun run test`
Expected: all green (no regressions).

- [ ] **Step 7: Commit**

```bash
git add src/daemon/social/grounded-judge.ts src/daemon/social/grounded-judge.test.ts src/daemon/bootstrap/index.ts
git commit -m "refactor(social): extract grounded judge into provider-agnostic seam (openai adapter)

Lift the openai-only socialRunTurn construction out of bootstrap into
daemon/social/grounded-judge.ts. makeGroundedJudgeRunTurn dispatches on the
default provider and returns null → cheapEval fallback. openai path behavior
unchanged; claude adapter follows. No user-facing change."
```

---

## Task 2: Claude adapter

**Files:**
- Modify: `src/core/claude-agent-provider.ts` (add `buildClaudeJudgeOptions` export)
- Modify: `src/daemon/social/grounded-judge.ts` (add claude branch + claude deps)
- Modify: `src/daemon/social/grounded-judge.test.ts` (claude dispatch + isolation tests)
- Modify: `src/daemon/bootstrap/index.ts` (thread claude judge deps)
- Modify: `src/daemon/bootstrap.test.ts` (integration: claude-default → grounded)

**Interfaces:**
- Consumes: `createClaudeAgentProvider` + `tierProfileToClaudeSdkOpts` (`src/core/claude-agent-provider.ts:192,68`), `classifyToolUse` (`src/core/user-tier.ts:228`), `SOCIAL_JUDGE_PROFILE`.
- Produces (in `claude-agent-provider.ts`):
  ```ts
  // Builds the SDK Options for a plugins-only judge session: mcpServers = plugins
  // only, tierProfileToClaudeSdkOpts(tp,'strict') for builtins, and a FRESH
  // minimal canUseTool that allows iff classifyToolUse(name,input)==='plugin_tool'
  // (never prompts — SOCIAL_JUDGE_PROFILE.relay is empty). Keeps Claude SDK types
  // (Options, CanUseTool) inside this file.
  export function buildClaudeJudgeOptions(args: {
    pluginMcpForClaude: Record<string, { type: 'stdio' } & McpStdioSpec>
    model: string
    claudeBin?: string
  }): (alias: string, path: string, tierProfile: TierProfile, chatId: string, mcpEnv?: Record<string, string>, appendInstructions?: string) => Options
  ```
- Produces (in `grounded-judge.ts`): extends `GroundedJudgeDeps` with
  ```ts
  claude?: { model: () => string; claudeBin?: string }
  ```

- [ ] **Step 1: Write the failing isolation test (the security lynchpin)**

Add to `src/daemon/social/grounded-judge.test.ts`:

```ts
import { buildClaudeJudgeOptions } from '../../core/claude-agent-provider'
import { SOCIAL_JUDGE_PROFILE } from '../../core/user-tier'

describe('buildClaudeJudgeOptions — isolation', () => {
  const opts = buildClaudeJudgeOptions({
    pluginMcpForClaude: { wxsearch: { type: 'stdio', command: '/x', args: [], env: {} } },
    model: 'claude-x',
  })('a', '/tmp', SOCIAL_JUDGE_PROFILE, '_social_judge')

  it('mcpServers are plugins-only — no wechat, no delegate', () => {
    expect(Object.keys(opts.mcpServers ?? {})).toEqual(['wxsearch'])
  })

  it('canUseTool allows a plugin MCP tool', async () => {
    const d = await opts.canUseTool!('mcp__wxsearch__find_facts', {}, {} as never)
    expect(d.behavior).toBe('allow')
  })

  it('canUseTool denies a non-plugin tool (Bash) — never prompts', async () => {
    const d = await opts.canUseTool!('Bash', { command: 'rm -rf /' }, {} as never)
    expect(d.behavior).toBe('deny')
  })
})

describe('makeGroundedJudgeRunTurn — claude', () => {
  it('returns a runTurn for claude', () => {
    const rt = makeGroundedJudgeRunTurn({
      ...baseDeps, providerId: 'claude', claude: { model: () => 'claude-x' },
    })
    expect(typeof rt).toBe('function')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run test src/daemon/social/grounded-judge.test.ts`
Expected: FAIL — `buildClaudeJudgeOptions` is not exported / claude branch returns null.

- [ ] **Step 3: Implement `buildClaudeJudgeOptions` in `claude-agent-provider.ts`**

Add (near `tierProfileToClaudeSdkOpts`), importing `classifyToolUse` and `SOCIAL_JUDGE_PROFILE` from `./user-tier`, and reusing the file's existing `Options`/`CanUseTool`/`McpStdioSpec` types:

```ts
export function buildClaudeJudgeOptions(args: {
  pluginMcpForClaude: Record<string, { type: 'stdio' } & McpStdioSpec>
  model: string
  claudeBin?: string
}): (alias: string, path: string, tierProfile: TierProfile, chatId: string, mcpEnv?: Record<string, string>, appendInstructions?: string) => Options {
  // Fresh minimal canUseTool: the judge only ever needs plugin tools; everything
  // else denies WITHOUT prompting (SOCIAL_JUDGE_PROFILE.relay is empty, so there
  // is no human to ask). Not makeCanUseTool — that resolves a tier NAME and
  // SOCIAL_JUDGE_PROFILE is not a named tier.
  const judgeCanUseTool: CanUseTool = async (toolName, input) =>
    SOCIAL_JUDGE_PROFILE.allow.has(classifyToolUse(toolName, input as Record<string, unknown>))
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: 'social judge: only plugin (wx*) tools are permitted' }

  return (_alias, path, tierProfile, _chatId, _mcpEnv, appendInstructions) => {
    const tierOpts = tierProfileToClaudeSdkOpts(tierProfile, 'strict')
    return {
      cwd: path,
      model: args.model,
      mcpServers: args.pluginMcpForClaude,   // plugins ONLY — no wechat/delegate
      systemPrompt: { type: 'preset', preset: 'claude_code', append: appendInstructions ?? '' },
      settingSources: ['project', 'local'],
      ...(args.claudeBin ? { pathToClaudeCodeExecutable: args.claudeBin } : {}),
      permissionMode: tierOpts.permissionMode,
      ...(tierOpts.disallowedTools ? { disallowedTools: tierOpts.disallowedTools } : {}),
      canUseTool: judgeCanUseTool,
    } as Options
  }
}
```

> If `CanUseTool` is not already imported/aliased in this file, import it from the same Claude SDK module the file uses for `Options`. Match the SDK's exact `canUseTool` return shape (`behavior: 'allow' | 'deny'`, `updatedInput`/`message`) — see the existing `makeCanUseTool` return values in `src/core/permission-relay.ts` for the concrete shape.

- [ ] **Step 4: Add the claude branch in `grounded-judge.ts`**

Extend `GroundedJudgeDeps` with `claude?: { model: () => string; claudeBin?: string }`, add the adapter, and wire the dispatch:

```ts
function buildClaudeJudgeProvider(deps: GroundedJudgeDeps): AgentProvider | null {
  const c = deps.claude
  if (!c) return null
  const pluginMcpForClaude = Object.fromEntries(
    Object.entries(deps.pluginMcp).map(([k, s]) => [k, { type: 'stdio' as const, ...s }]),
  )
  return {
    async spawn(project, ctx) {
      const { createClaudeAgentProvider, buildClaudeJudgeOptions } = await import('../../core/claude-agent-provider')
      const provider = createClaudeAgentProvider({
        sdkOptionsForProject: buildClaudeJudgeOptions({ pluginMcpForClaude, model: c.model(), claudeBin: c.claudeBin }),
        ...(c.claudeBin ? { claudeBin: c.claudeBin } : {}),
      })
      return provider.spawn(project, ctx)
    },
  }
}
```

In `makeGroundedJudgeRunTurn`, add before the null-check:

```ts
else if (deps.providerId === 'claude') provider = buildClaudeJudgeProvider(deps)
```

- [ ] **Step 5: Run the module tests to verify they pass**

Run: `bun run test src/daemon/social/grounded-judge.test.ts`
Expected: PASS (openai + claude dispatch + isolation).

- [ ] **Step 6: Thread claude deps in bootstrap + add the integration assertion**

In `src/daemon/bootstrap/index.ts`, extend the `makeGroundedJudgeRunTurn({...})` call (from Task 1 Step 5) with:

```ts
  claude: { model: () => currentClaudeModel(), ...(claudeBin ? { claudeBin } : {}) },
```

(`currentClaudeModel` and `claudeBin` are already in scope in the bootstrap closure — see `bootstrap/index.ts:661,542`.)

Add to `src/daemon/bootstrap.test.ts` (mirror the existing knowledge-orchestration test's fixture that loads a plugin from the bundled dir): assert that with `provider: 'claude'` and a loaded plugin, the BOOT log contains `plugin-grounded judge via claude` (not the cheapEval-fallback line). Capture logs via the `log` dep the test already passes to `buildBootstrap`.

```ts
it('claude-default daemon with a plugin selects the grounded judge path (not cheapEval)', async () => {
  const logs: string[] = []
  // …build bootstrap with provider:'claude', social_enabled + disclosure policy set,
  //   a bundled plugin present (reuse the knowledge-orchestration fixture setup),
  //   log: (_tag, m) => logs.push(m) …
  expect(logs.some(m => m.includes('plugin-grounded judge via claude'))).toBe(true)
  expect(logs.some(m => m.includes('falls back to cheapEval'))).toBe(false)
})
```

- [ ] **Step 7: Verify typecheck + suites**

Run: `bun run typecheck`
Expected: 0 errors.

Run: `bun run test src/daemon/social/grounded-judge.test.ts src/daemon/bootstrap.test.ts src/core/social-m1.e2e.test.ts src/core/user-tier.test.ts`
Expected: PASS.

Run: `bun run test && bun run depcheck`
Expected: full suite green, 0 dependency violations.

- [ ] **Step 8: Commit**

```bash
git add src/core/claude-agent-provider.ts src/daemon/social/grounded-judge.ts src/daemon/social/grounded-judge.test.ts src/daemon/bootstrap/index.ts src/daemon/bootstrap.test.ts
git commit -m "feat(social): grounded judge on Claude — plugins-only judge session

buildClaudeJudgeOptions builds a plugins-only judge Options bag (no
wechat/delegate) with a fresh minimal canUseTool that allows iff the tool
classifies as plugin_tool and never prompts. Wired behind
makeGroundedJudgeRunTurn's claude branch, so a Claude-default daemon now judges
grounded (reads wx* facts) instead of degrading to cheapEval."
```

---

## Follow-ons (out of scope; documented)

- `codex`, `cursor`, `gemini` adapters — same seam: add a `buildXJudgeProvider` returning a plugins-only provider. Until then they return `null` → `cheapEval`, with the BOOT log naming the gap. `cursor`'s coarser tier/sandbox needs care.
- No separate judge-model knob (judge uses the default provider's configured model — YAGNI).

## Self-Review notes (author)

- **Spec coverage:** new module + seam (spec §Design) → Task 1; plugins-only isolation invariant (spec §Security) → Task 2 Steps 1,3 (isolation tests) + Global Constraints; cheapEval fallback + BOOT log (spec §Error handling) → Task 1 Step 5; testing matrix (spec §Testing) → Tasks 1–2 tests. Openai-refactor-no-behavior-change → Task 1 Step 6 (e2e).
- **Spec divergence flagged:** the spec framed the Claude adapter as a "near-mirror." Reality (found while planning): Claude gates MCP tools through `canUseTool`, and the existing `makeCanUseTool` resolves a tier *name* — `SOCIAL_JUDGE_PROFILE` is not a named tier. Resolution baked into Task 2: a fresh minimal `canUseTool` in `buildClaudeJudgeOptions` (allow iff `plugin_tool`, else deny, never prompt). Safe because `SOCIAL_JUDGE_PROFILE.deny` is comprehensive (already tested, `user-tier.test.ts:374-382`).
- **Type consistency:** `makeGroundedJudgeRunTurn`, `JudgeRunTurn`, `GroundedJudgeDeps`, `buildClaudeJudgeOptions` names/signatures match across tasks. `pluginMcp` (openai raw form) vs `pluginMcpForClaude` (`{type:'stdio', ...}`) transform is explicit and confined to the claude adapter.
