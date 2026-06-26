# Unified per-spawn system-prompt seam (+ self-heal nudge as its first beneficiary)

**Date:** 2026-06-25
**Status:** approved (revised after architecture review)
**Related:** [[ai-native-self-healing]] — diagnostic_*/remediation tools already
shipped; this adds the "when to use" nudge AND unifies how every provider
receives its per-spawn system prompt.

## Why this is an architecture change, not a one-off

The immediate goal is small: tell the admin-tier agent it can self-diagnose/heal
and when to reach for the `diagnostic_*` / remediation tools. But the agent's
system prompt is delivered **differently per provider**, and the tier-gated
nudge exposed that fragmentation:

- **claude** builds its prompt per spawn inside `sdkOptionsForProject`
  (`bootstrap/index.ts:448`), which receives `tierProfile` — so a tier-gated
  section is natural.
- **codex** has no system-prompt slot; it prepends `appendInstructions` to the
  first user message, and that text is fixed at **provider construction**
  (`bootstrap/index.ts:639`), tier-agnostic.
- **cursor** injects **no** prompt at all today (not even base channel rules).

Bolting the self-heal section onto each provider separately (per-spawn for
claude, a new per-spawn branch inside the codex provider, …) would deepen that
fragmentation — a new path per provider, and again for gemini next. Rejected.

Instead we unify the seam, following the **existing precedent** in the very same
interface: `SpawnContext.mcpEnv` is "computed once by the daemon
(session-manager) from the resolved tier; the provider stays oblivious and just
merges it." The system prompt should travel the same way.

## Unified design

**The per-spawn system prompt becomes a `SpawnContext` field, computed once by
the daemon and injected by each provider through its own transport — no
provider assembles sections or knows about tiers/tools.**

1. **`SpawnContext.appendInstructions?: string`** (`core/agent-provider.ts`) —
   doc mirrors `mcpEnv`: daemon-computed, provider stays oblivious to content.
2. **One content assembler:** `buildSystemPrompt` (`core/prompt-builder.ts`)
   stays the single, provider-agnostic source of every section. It gains
   `daemonOpsAvailable?: boolean` → appends `daemonSelfHealSection()` when true.
   All sections, including self-heal, are defined here once.
3. **session-manager** computes `appendInstructions` per spawn exactly where it
   already computes `mcpEnv`, via an injected thunk
   `buildInstructions?: (providerId, tierProfile) => string`, and forwards it in
   the `SpawnContext`.
4. **bootstrap** supplies that thunk (it owns peer/companion/delegate config):
   `buildInstructions(providerId, tierProfile) = buildSystemPrompt({ providerId,
   peerProviderId, companionEnabled, delegateAvailable(provider),
   daemonOpsAvailable: tierProfile.allow.has('daemon_introspect') })`. The two
   scattered `buildSystemPrompt` calls (448, 639) are removed.
5. **Providers only inject** `spawnOpts.appendInstructions` via their transport:
   - claude → `systemPrompt: { preset:'claude_code', append }` (sdkOptionsForProject
     gains an `appendInstructions` param; stops calling buildSystemPrompt).
   - codex → prepend to the first dispatch (uses `spawnOpts.appendInstructions`
     instead of construction-time `opts.appendInstructions`, which is removed).
   - cursor → subscribes later (it injects no prompt today; a one-line follow-up
     when its first-message injection is wired — the field is already there).

### Self-heal section content (~7 lines, "when to use", no rules/keywords)

> ## 自我诊断 / 自愈（管理员）
> 你能检查并修复自己所在的 daemon。当主人反映「卡住 / 不回 / 变慢 / 这个对话没反应」这类**运行异常**（不是内容问题）时，主动排查而不是只道歉：
> - 先查：`diagnostic_health`（心跳 / 活跃会话数）、`diagnostic_turns`（最近回合结局 completed/timeout/auth_failed/error）、`diagnostic_sessions`。
> - 再据情况：某回合 timeout/卡死 → `session_release`；模型固定错了 / 一直 404 → `model_set`；整体像卡死且前面都没用 → `daemon_restart`。
> - 修完用各自的读回（release 的 sessions、model_set 的 model、restart 的 ok）核对，再用自然语言把「查到什么、做了什么、好没好」简短汇报。
> - 这些是高权限操作，会先要你确认（relay）；不确定就只诊断、把结果告诉主人。

## Consistency guarantee

The section appears iff `tierProfile.allow.has('daemon_introspect')` — exactly
the predicate the tools register under (`WECHAT_SESSION_TIER==='admin'`,
provider-agnostic). Computed once in the daemon thunk, so claude and codex are
identical by construction. Non-admin sessions get neither tools nor section.

## Blast radius & testing

This changes how **every** session gets its prompt, not just admin. Covered by
existing provider + session-manager + prompt-builder suites, plus:

1. `prompt-builder.test.ts`: `daemonOpsAvailable` true → section markers present
   (`自我诊断`, `diagnostic_health`, `session_release`); false/omitted → absent.
2. `session-manager.test.ts`: when `buildInstructions` is wired, the value it
   returns is forwarded as `spawnOpts.appendInstructions` to `provider.spawn`;
   omitted → `appendInstructions` undefined (no crash).
3. `codex-agent-provider.test.ts`: first dispatch prepends
   `spawnOpts.appendInstructions`; second dispatch does not re-inject; absent →
   no prefix. (Existing "appendInstructions" test migrates from construction-arg
   to spawn-ctx.)
4. `claude-agent-provider.test.ts`: `spawnOpts.appendInstructions` reaches the
   SDK `systemPrompt.append`.

## Out of scope

- No monitoring tick / proactive detection (user: report-driven only).
- No keyword classifier.
- Tool descriptions unchanged; the "when" lives in the one section.
- cursor prompt injection wiring (it injects nothing today) — follow-up; the
  unified field is ready for it.
