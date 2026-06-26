# Self-heal capability nudge in the agent prompt

**Date:** 2026-06-25
**Status:** approved
**Related:** [[ai-native-self-healing]] memory — diagnostic_* + remediation tools
(step 1/2) already shipped; this is the "optional next (a)" prompt nudge.

## Problem

The daemon already exposes 7 admin-only self-heal MCP tools — `diagnostic_turns`,
`diagnostic_sessions`, `diagnostic_health`, `model_get`, `model_set`,
`session_release`, `daemon_restart` — registered on the wechat MCP child only
when `WECHAT_SESSION_TIER === 'admin'` (provider-agnostic; injected into both
claude and codex children). But nothing tells the agent *when* to reach for
them. The system prompt (`src/core/prompt-builder.ts`) never mentions them, and
the tool descriptions are "what it does", not "when to use". So when the owner
reports a runtime symptom ("卡住了 / 不回我 / 变慢"), the agent tends to just
apologize instead of running a diagnosis — the invested tooling sits idle.

We are NOT adding keyword matching or an auto-trigger. The agent keeps reasoning
freely; we only give it a short capability-awareness pointer so it knows the
tools exist and the kind of situation they fit.

## Both providers, gated by per-spawn admin tier

The tools register on admin sessions for **both** claude and codex (verified:
`src/mcp-servers/wechat/main.ts:55,597` gates on `WECHAT_SESSION_TIER==='admin'`;
`src/core/codex-agent-provider.ts:209-219` merges that env into the codex wechat
child via `mergeEnvIntoMcpServers`). A codex-only install with an admin chat can
self-heal. So the nudge must reach both providers — and only when the session is
admin tier, to stay consistent with which sessions actually have the tools.

The two providers inject their prompt differently:

- **claude** builds `systemPrompt` per spawn inside `sdkOptionsForProject`
  (`bootstrap/index.ts:448`), which already receives `tierProfile`. Natural fit.
- **codex** has no system-prompt slot; it prepends `appendInstructions` to the
  first user message, and that base text is fixed at provider construction
  (`bootstrap/index.ts:639`), tier-agnostic. But `createSession` receives
  `spawnOpts.tierProfile` (`codex-agent-provider.ts:201`) and the first-message
  injection happens there (`:270`), so the admin section can be appended
  per-spawn.

## Change

1. `src/core/prompt-builder.ts`:
   - Export `daemonSelfHealSection(): string` (single source of truth).
   - `BuildSystemPromptArgs` gains `daemonOpsAvailable?: boolean` (default false);
     `buildSystemPrompt` appends the section only when true.
2. `src/daemon/bootstrap/index.ts:448` (claude): pass
   `daemonOpsAvailable: tierProfile.allow.has('daemon_introspect')` — the same
   admin predicate used by tool registration and `tierNameFromProfile`.
3. `src/core/codex-agent-provider.ts`: at `createSession`, compute
   `daemonOps = spawnOpts.tierProfile.allow.has('daemon_introspect')`; the
   first-dispatch injection uses `appendInstructions` plus, when `daemonOps`, the
   `daemonSelfHealSection()` text. The construction-time call at
   `bootstrap/index.ts:639` does NOT include the section (base stays
   tier-agnostic).

### Section content (~7 lines, "when to use", no rules/keywords)

> ## 自我诊断 / 自愈（管理员）
> 你能检查并修复自己所在的 daemon。当主人反映「卡住 / 不回 / 变慢 / 这个对话没反应」这类**运行异常**（不是内容问题）时，主动排查而不是只道歉：
> - 先查：`diagnostic_health`（心跳 / 活跃会话数）、`diagnostic_turns`（最近回合结局 completed/timeout/auth_failed/error）、`diagnostic_sessions`。
> - 再据情况：某回合 timeout/卡死 → `session_release`；模型固定错了 / 一直 404 → `model_set`；整体像卡死且前面都没用 → `daemon_restart`。
> - 修完用各自的读回（release 的 sessions、model_set 的 model、restart 的 ok）核对，再用自然语言把「查到什么、做了什么、好没好」简短汇报。
> - 这些是高权限操作，会先要你确认（relay）；不确定就只诊断、把结果告诉主人。

## Consistency guarantee

The section appears iff `tierProfile.allow.has('daemon_introspect')` — exactly
the condition under which the tools register, on both providers. Non-admin
sessions (guest/trusted) get neither the tools nor the section. No tool the
prompt mentions is ever absent from the session.

## Testing (TDD)

1. `prompt-builder.test.ts`: `daemonOpsAvailable:true` → output contains section
   markers (`自我诊断`, `diagnostic_health`, `session_release`);
   omitted/`false` → absent. Existing 17 tests unaffected.
2. `codex-agent-provider.test.ts`: admin spawn → first-dispatch input contains
   the section; guest/trusted spawn → does not. Second dispatch never re-injects
   (existing once-only invariant holds).

## Out of scope

- No monitoring tick / proactive detection (user chose "report-driven only").
- No keyword classifier.
- Tool descriptions left as-is; the "when" lives in this one section.
- cursor provider: `buildSystemPrompt` doesn't serve it today; separate follow-up
  if cursor ever needs admin self-heal.
