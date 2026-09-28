/**
 * buildBootstrap — wires up the daemon's core dispatch graph.
 *
 * Composes:
 *   - Provider registry (Claude + Codex providers)
 *   - SessionManager (LRU-evicting cache of (provider, alias) → session)
 *   - ConversationStore (per-chat mode persistence)
 *   - ConversationCoordinator (mode-aware dispatch entry)
 *   - Bare delegate providers (RFC 03 P4 peer-as-tool)
 *
 * Boot order inside buildBootstrap(): wireHealth (connection-health runtime,
 * first + unconditional) → stores (conversationStore, plugin MCP specs) →
 * sessions (sessionStore + registerProviders) →
 * sendAssistantText / recordTurn / coordinator → dispatchDelegate → A2A
 * infra (registry/client/eventsStore + resolveOperatorChatId) → wireSocial
 * → wireA2aServer → 乙 v2 (yiHub/yiClient) → return.
 *
 * Helpers extracted for readability:
 *   - ./types.ts       — BootstrapDeps / Bootstrap interfaces
 *   - ./mcp-specs.ts   — wechat / delegate stdio MCP spec builders
 *   - ./session-paths.ts — per-provider jsonl path resolvers (canResume probes)
 *   - ./delegate.ts    — bare delegate providers + dispatchDelegate
 *   - ./providers.ts   — provider registrations (claude/codex/cursor/openai/gemini)
 *   - ./wire-social.ts — 社交接线(笔友信道 / 串门 / 心愿)
 *   - ./wire-a2a-server.ts — A2A HTTP server + routeA2ANotify + a2a-info.json
 *   - ./wire-health.ts — connection-health runtime (onFailure/onSuccess)
 *
 * Imported only by:
 *   - src/daemon/main.ts (production entry)
 *   - src/daemon/bootstrap.test.ts (integration tests)
 */
import { SessionManager } from '../../core/session-manager'
import type { TierProfile } from '../../core/user-tier'
import { createConversationCoordinator, type ConversationCoordinator, type TurnRecord } from '../../core/conversation-coordinator'
import type { ProviderId } from '../../core/conversation'
import { formatInbound } from '../../core/prompt-format'
import { makeMessagesStore } from '../../lib/messages-store'
import { findOnPath } from '../../lib/util'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeSessionStore } from '../../core/session-store'
import { loadAgentConfig } from '../../lib/agent-config'
import { loadAccess, setSessionInvalidator } from '../../lib/access'
import { resolveAdminChatId } from '../companion/resolve-admin'
import { buildDelegateDispatch } from './delegate'
import { makeSendAssistantText } from './fallback-reply'
import { registerProviders } from './providers'
import { wirePlugins } from './wire-plugins'
import { wireKnowledge } from './wire-knowledge'
import { wirePermissions } from './wire-permissions'
import { wireModelOptions } from './wire-model-options'
import { wireInstructions } from './wire-instructions'
import { Ref } from '../../lib/lifecycle'
import { resolveClaudeBinary, hydrateClaudeAuthEnvFromUserSettings } from './claude-env'
import { wireSocial } from './wire-social'
import { wireA2aServer } from './wire-a2a-server'
import { wirePairing } from './wire-pairing'
import { wireHealth, reportLlmTurnOutcome } from './wire-health'
import { wireSelfRestart } from './wire-self-restart'
import { resolveSelfAgentId } from '../../core/self-agent-id'
import { assertNotAuthFailed, type CheapEval } from '../../core/agent-provider'
import { createA2ARegistry } from '../../core/a2a-registry'
import { createA2AClient } from '../../core/a2a-client'
import { makeA2AEventsStore } from '../../core/a2a-events-store'
import { createYiHub, type YiHub } from '../../core/yi-hub'
import { createYiWsServer } from '../yi-ws-server'
import { shouldNoteTurnEnd } from '../pet-signals'
import type { BootstrapDeps, Bootstrap } from './types'
export type { BootstrapDeps, Bootstrap } from './types'

// buildChannelSystemPrompt() moved to src/core/prompt-builder.ts in
// the RFC 03 review follow-up: the inline string here was v0.x and
// missed delegate_*, share_*, broadcast, set_user_name, send_file,
// edit_message — none of which were in the prompt despite being
// available tools. The prompt-builder also encodes mode-awareness so
// the agent doesn't get confused by chatroom envelopes.

/**
 * PR F — wrap a CheapEval so the auth-failed sentinel (Claude's "Not
 * logged in / Please run /login" emitted as assistant text; Codex's
 * "401 unauthorized" etc.) is converted into a thrown error instead of
 * leaking to downstream JSON parsers. The chatroom moderator's
 * existing `haiku eval threw` branch then falls back to forced
 * alternation, and the auth-failed log line surfaces in channel.log
 * alongside solo/parallel auth-failures (single vocabulary across paths).
 *
 * Returns undefined when the registry has no cheapEval — the coordinator
 * treats `haikuEval: undefined` as absent, skipping beat ②b and beat ③.
 */
export function wrapCheapEvalWithAuthFailCheck(
  cheapEval: CheapEval | null,
  log: BootstrapDeps['log'],
): ((prompt: string) => Promise<string>) | undefined {
  if (!cheapEval) return undefined
  return async (prompt: string) => {
    const text = await cheapEval(prompt)
    assertNotAuthFailed(text, (tag, line) => log(tag, line), 'cheap-eval moderator')
    return text
  }
}

// resolveAdminChatId moved to ../companion/resolve-admin.ts (fix round 1,
// owner-onboarding design §C1 review) so companion/offer-eligibility.ts can
// reuse the SAME owner-resolution rule without importing this whole
// composition-root file. Re-exported here so existing callers (main.ts,
// bootstrap.test.ts) that do `import { resolveAdminChatId } from './bootstrap'`
// keep working unchanged.
export { resolveAdminChatId } from '../companion/resolve-admin'

export async function buildBootstrap(deps: BootstrapDeps): Promise<Bootstrap> {
  hydrateClaudeAuthEnvFromUserSettings(deps.log)

  // Subsystem degraded-boot (spec 2026-08-17) — the five optional wire
  // blocks below (knowledge/social/a2a-server/pairing/self-restart) start
  // through this supervisor so a startup failure degrades that block to
  // "not configured" instead of aborting the whole daemon boot.
  const sup = deps.supervisor
  // 各 wire-* 共用的上下文(BootstrapCtx);configuredAgent 在下面第 5 步才有,
  // 之前的 wire 用 ctxBase,之后的用 ctx。
  const ctxBase = { sup, log: deps.log, stateDir: deps.stateDir, db: deps.db }

  // Connection-health runtime (Task 7) — constructed FIRST and unconditionally,
  // no config gate, so it exists before anything that could report a failure:
  // main.ts's registerPolling(wired.pollingDeps) starts the long-poll loops
  // strictly after buildBootstrap() resolves, and buildTickBodies' companion
  // ticks are wired the same way. Depends only on stateDir + log, both
  // present from the very first line of BootstrapDeps.
  const health = wireHealth({ stateDir: deps.stateDir, log: deps.log })

  // busy / resolver / permissionMode / conversationStore / canUseTool — ./wire-permissions.ts(2026-09-27 拆分)。
  const { busyRegistry, resolve, permissionMode, conversationStore, buildCanUseTool } = wirePermissions(deps, ctxBase)

  const claudeBin = resolveClaudeBinary()
  if (!claudeBin) {
    deps.log('BOOT', 'WARNING: no Claude Code binary found — install Claude Code (`claude`) or set CLAUDE_CODE_EXECUTABLE')
  } else {
    deps.log('BOOT', `claude binary: ${claudeBin}`)
  }

  // MCP specs + plugin lane — ./wire-plugins.ts(2026-09-27 拆分)。
  const {
    wechatStdioForClaude, wechatStdioForCodex, wechatStdioForCursor, wechatStdioForOpenai, wechatStdioForGemini, wechatStdioForAgy,
    delegateStdioByProvider, delegateStdioForClaude, delegateStdioForCodex, delegateStdioForCursor, delegateStdioForOpenai,
    loadedPlugins, pluginMcp, knowledgePluginNames, pluginMcpForClaude,
  } = wirePlugins(deps, ctxBase)

  // Pin a Claude model from agent-config.json (or fall back to a stable
  // full ID). Without this, the spawned Claude Code subprocess inherits
  // whatever `~/.claude/.claude.json` says — which breaks the daemon
  // whenever the user's interactive CLI uses an alias the SDK subprocess
  // can't resolve. 2026-05-08 incident: user had fast-mode `opus[1m]`
  // configured for interactive sessions; CLI 2.1.133 mis-parsed that
  // under SDK mode and sent literal `"opus"` to the API → 404 on every
  // inbound. The codex side already pinned model from config; Claude
  // didn't, so this closes that asymmetry. `configuredAgent` is the boot
  // snapshot used for codex/cursor construction + startup logging.
  const configuredAgent = loadAgentConfig(deps.stateDir)

  // spec §2 (pairing-code design) — one stable-unique slug per daemon,
  // resolved EXACTLY ONCE here and threaded into every wiring seam that
  // self-reports an agent_id to a peer: wireSocial (outbound a2a_id),
  // wirePairing (own-card self_id), and pipeline-deps' exec/hands delegate
  // path (delegateToHand). resolveSelfAgentId persists on its
  // generate/grandfather branch (read-modify-write of agent-config.json) —
  // calling it more than once per boot (let alone lazily, per request) would
  // re-enter that persistence for no benefit and risks two wiring seams
  // momentarily disagreeing on this daemon's own identity.
  const selfId = resolveSelfAgentId(configuredAgent, deps.stateDir)

  // Knowledge Kernel — ./wire-knowledge.ts(2026-09-27 拆分);经 sup.start('knowledge')。
  const ctx = { ...ctxBase, configuredAgent }
  const knowledge: Bootstrap['knowledge'] = await wireKnowledge(ctx, loadedPlugins)

  // 模型热读 + Claude SDK Options — ./wire-model-options.ts(2026-09-27 拆分)。
  const { readAgentConfig, currentClaudeModel, currentModelFor, sdkOptionsForProject } = wireModelOptions(ctxBase, { plugins: { wechatStdioForClaude, delegateStdioForClaude, pluginMcpForClaude }, permissionMode, buildCanUseTool, claudeBin })

  // Persistent session_id map — enables `resume` after daemon restart.
  // Each provider stores its session/thread jsonl in a different place; we
  // probe the right one before trying to resume (avoids hard error if the
  // SDK rotated or user cleared history). See ./session-paths.ts.
  const sessionStore = makeSessionStore(deps.db, { migrateFromFile: join(deps.stateDir, 'sessions.json') })

  // Per-turn watchdog: the daemon-level bound that guarantees a silently-
  // stalled SDK subprocess (idle timeout, wedge, hung MCP tool) can never
  // wedge the pipeline forever. Defaults to 10 min — generous enough for a
  // legit long turn (memory reads, MCP tools, deep thinking) yet finite, so
  // the coordinator always reclaims the session and the next message is
  // served. Override via WECHAT_TURN_TIMEOUT_MS (0 disables — not advised).
  // Resolved here (moved ahead of registerProviders in the agy-provider
  // task) so the agy provider's `--print-timeout` can share this exact
  // value at registration time, same as the coordinator does below.
  const turnTimeoutMs = (() => {
    const raw = process.env['WECHAT_TURN_TIMEOUT_MS']
    if (raw == null || raw === '') return 10 * 60_000
    const n = Number(raw)
    return Number.isFinite(n) && n >= 0 ? n : 10 * 60_000
  })()

  // provider 异常备注(fallback 连击),与 providers.ts 的版本/探测备注合并进 /mode。
  const anomalyNotes = new Map<ProviderId, string>()
  const { registry, defaultProviderId, codexBinary, codexVersionCheck, providerNotes: baseProviderNotes } = await registerProviders({
    log: deps.log,
    stateDir: deps.stateDir,
    ilink: deps.ilink,
    agentProviderKind: deps.agentProviderKind,
    configuredAgent,
    permissionMode,
    conversationStore,
    sdkOptionsForProject,
    claudeBin,
    currentClaudeModel,
    resolveAdminChatId,
    pluginMcp,
    wechatStdioForCodex,
    delegateStdioForCodex,
    wechatStdioForCursor,
    delegateStdioForCursor,
    wechatStdioForOpenai,
    delegateStdioForOpenai,
    wechatStdioForGemini,
    wechatStdioForAgy,
    turnTimeoutMs,
    mintSessionToken: deps.mintSessionToken,
    agyGeminiConfigDir: deps.agyGeminiConfigDir,
  })

  // 系统提示组装 — ./wire-instructions.ts(2026-09-27 拆分)。socialWired 在下面 social 接线完成后 set。
  const socialWired = new Ref<boolean>('socialWired')
  const buildInstructions = wireInstructions(deps, { plugins: { delegateStdioByProvider, knowledgePluginNames }, defaultProviderId, knowledge, socialWired })

  const sessionManager = new SessionManager({
    maxConcurrent: 6,
    idleEvictMs: 30 * 60_000,
    registry,
    sessionStore,
    resumeTTLMs: 7 * 24 * 60 * 60_000,
    // Per-session auth token lifecycle — minted once per spawn, revoked on
    // every release/eviction. Both keyed by provider/alias/chatId so they pair.
    mintSessionToken: deps.mintSessionToken,
    invalidateSessionToken: deps.invalidateSession,
    buildInstructions,
    currentModelFor,
  })

  // Task 14 — when admins / trusted / allowFrom set membership changes in
  // access.json, shut down all live sessions so the next acquire respawns
  // under the new tier. Single-step rule: edit access.json → next inbound
  // runs under new tier. Up to 5s lag while the in-process cache holds the
  // old snapshot. Errors during shutdown are logged but swallowed (the
  // access reader must never crash the caller).
  setSessionInvalidator(() => {
    deps.log('ACCESS', 'tier membership changed — invalidating all live sessions')
    void sessionManager.shutdown().catch(err => {
      deps.log('ACCESS', `invalidate shutdown error: ${err instanceof Error ? err.message : String(err)}`)
    })
  })

  // self-restart (spec 2026-08-03-daemon-self-restart-on-stale-code) —
  // assembly extracted to ./wire-self-restart.ts (Task 6). Entirely inert
  // when deps.requestRestart is omitted: wireSelfRestart returns null, so
  // no HEAD read, no activity marker built, no check added to the
  // idle-sweep tick below — tests and minimal embeddings that don't wire
  // requestRestart stay byte-identical to before this feature existed.
  //
  // lastPollSuccessAgoMs (spec 2026-08-11 §4) — real signal, sourced from
  // the SAME health runtime constructed above (poll-loop.ts's
  // health.onSuccess('wechat') call is what stamps lastSuccessAt). health
  // can't get() fail in practice (makeConnectionHealth lazily seeds any
  // never-seen dependency), but the try/catch + null-on-failure keeps this
  // on the "can't prove it's fresh ⇒ don't restart" side the rest of the
  // mechanism commits to everywhere else.
  const wiredSelfRestart = (await sup.start('self-restart', () => wireSelfRestart({
    requestRestart: deps.requestRestart,
    anyInFlight: () => sessionManager.anyInFlight(),
    busy: () => busyRegistry.busy(),
    lastPollSuccessAgoMs: (nowMs) => {
      try {
        const at = health?.health.get('wechat').lastSuccessAt ?? null
        return at === null ? null : nowMs - at
      } catch { return null }
    },
    log: deps.log,
  }))) ?? null
  const selfRestartCheck = wiredSelfRestart?.check ?? null
  const selfRestartActivityMarker = wiredSelfRestart?.marker ?? null

  // Periodic idle sweep — without this, idleEvictMs is dead config (the
  // method exists but was never called from production paths). 30 min of
  // inactivity is the limit before a session is dropped; the next dispatch
  // spawns a fresh subprocess that re-reads keychain credentials. Required
  // to avoid the long-running-daemon OAuth-staleness path that surfaces as
  // the claude binary streaming "Not logged in · Please run /login" as
  // assistant text. unref() so the timer never keeps the event loop alive
  // (matters for tests that build a real bootstrap and then exit).
  //
  // selfRestartCheck rides this SAME 60s tick (no new timer) — see the
  // self-restart block above. It swallows its own errors, so no .catch here.
  const idleSweepTimer = setInterval(() => {
    sessionManager.sweepIdle().catch(err => {
      deps.log('IDLE_SWEEP', `error: ${err instanceof Error ? err.message : String(err)}`)
    })
    void selfRestartCheck?.()
  }, 60_000)
  idleSweepTimer.unref()

  // Per-chat conversation mode (RFC 03 P2). Default for new chats =
  // `conversationStore` is created earlier in this function (hoisted so
  // the canUseTool closure has a live reference). `/cc` `/codex` `/solo`
  // commands flip individual chats; persisted in `wechat-cc.db`'s
  // `conversations` table (migrated from the legacy conversations.json
  // in PR7). Caller may inject a shared instance so internal-api
  // (which needs to look up modes for reply-prefixing in P3 parallel
  // mode) sees the same flips. When absent, we own one rooted at <stateDir>.

  // Extracted as a named variable so routeA2ANotify can also call it.
  // v0.5.3 — extracted to fallback-reply.ts so the failure paths log
  // [FALLBACK_REPLY_FAIL] / success path logs [FALLBACK_REPLY_SENT].
  const sendAssistantText = makeSendAssistantText({ sendMessage: deps.ilink.sendMessage, log: deps.log, capture: deps.replySinks?.capture, observe: deps.outboundTaps?.observe })

  // (turnTimeoutMs is resolved earlier now — see the block just above
  // registerProviders() — so the agy provider's `--print-timeout` can be
  // constructed with the same value the coordinator uses below.)

  // recordTurn — emit the structured TurnRecord as a fields-bearing log line
  // AND persist it via the optional onTurnRecord sink. deps.log routes the
  // third arg into channel.log.jsonl, so every turn's outcome (completed /
  // timeout / auth_failed / error) is greppable there; onTurnRecord (wired in
  // main.ts to the SQLite turn_records store) makes it *queryable* on
  // internal-api and survives the restart a hang/crash triggers — the
  // AI-legible answer to "why did this chat stop replying", post-mortem-safe.
  const recordTurn = (record: TurnRecord): void => {
    // tools=… 只列**名字**,不含参数(参数里是搜索词、文件路径、消息正文)。
    // 有了这一栏,回头看一条回答时能一眼分清「查来的」和「想出来的」——
    // 2026-09-02 之前完全看不出:agy 联网搜了 3.7 秒,日志里只有 chunks=3。
    const toolsPart = record.toolCalls?.length
      ? ` tools=${[...new Set(record.toolCalls)].join(',')}`
      : ''
    deps.log('TURN', `chat=${record.chatId} provider=${record.provider} outcome=${record.outcome} dur=${record.durationMs}ms reply=${record.replyToolCalled} chunks=${record.textChunks}${toolsPart}${record.error ? ` error=${JSON.stringify(record.error.slice(0, 160))}` : ''}`, {
      event: 'turn_record',
      ...record,
    })
    // Persistence is best-effort: a store write must never break dispatch.
    try { deps.onTurnRecord?.(record) } catch (err) {
      deps.log('TURN', `onTurnRecord sink threw: ${err instanceof Error ? err.message : String(err)}`)
    }
    // Connection-health (Task 9) — this is the narrowest point that sees
    // BOTH a completed and a failed LLM round: it fires once per solo
    // dispatch and once per participant in parallel/chatroom (see
    // TurnRecord's doc comment), covering every provider call the
    // coordinator makes. The outcome→failure-kind mapping (why 'unknown'
    // business failures like step-budget/max_turns must NOT count as an
    // 'llm' connectivity failure) lives in reportLlmTurnOutcome
    // (./wire-health.ts) — extracted so it's unit-testable against a real
    // health runtime without constructing a full Bootstrap.
    reportLlmTurnOutcome(health, record.outcome, record.error)
    // 桌宠(spec 2026-09-05-cc-desktop-pet §5.1)—— 回合结束的那一刻。recordTurn
    // 是唯一一处**每种结局都会经过**的窄点,所以「刚忙完」用它的 endedAt,而不是
    // 任何一条成功路径上的时间。但不是每条记录都算一次「忙完」:哪些算,判据写在
    // shouldNoteTurnEnd 里(只认 completed;chatroom 每participant每拍一条,得排除)。
    if (shouldNoteTurnEnd(record)) deps.petSignals?.noteTurnEnd(record.chatId, record.endedAt)
  }

  const handoffMessages = makeMessagesStore(deps.db)
  const coordinator = createConversationCoordinator({
    resolveProject: resolve,
    manager: sessionManager,
    conversationStore,
    registry,
    defaultProviderId,
    format: formatInbound,
    // 换 provider 交接的近况原文 — 消息库最近 n 条(text 类为主,升序)。
    // 非管理员可用的 provider 允许表(core/provider-policy.ts),mtime 缓存读。
    trustedProviders: () => readAgentConfig().trusted_providers,
    // 连续走 fallback 的 provider:≥3 轮就是「流格式变了」的形状,记进 /mode
    // 并打一条 [PROVIDER_ANOMALY](每 10 轮再提醒一次,别刷屏)。
    onFallbackStreak: (providerId, streak) => {
      if (streak === 0) { anomalyNotes.delete(providerId); return }
      if (streak < 3) return
      anomalyNotes.set(providerId, `最近 ${streak} 轮连续走 fallback(有文字、零 reply 工具)—— 像是流格式变了,看 channel.log 的 tools=`)
      if (streak === 3 || streak % 10 === 0) deps.log('PROVIDER_ANOMALY', `provider=${providerId} fallback streak=${streak}: 有文字、零 reply 工具,像是流格式变了(tool_call 解析不出来);见 TURN 行的 tools=`, { event: 'fallback_streak', provider: providerId, streak })
    },
    recentTurns: async (chatId, n) => {
      const rows = await handoffMessages.listRange(chatId, { limit: n })
      return rows.filter(r => r.text.trim().length > 0)
        .map(r => ({ dir: r.direction === 'in' ? 'in' as const : 'out' as const, text: r.text, ts: r.ts }))
    },
    permissionMode,
    turnTimeoutMs,
    recordTurn,
    // 桌宠「在干活」的证据(spec §5.1):只认 tool_call —— 起飞由
    // sessionManager.isInFlight 判定,起飞时刻由 pipeline-deps 的入站分发处
    // noteTurnStart 记(见 pet-signals.ts 的头注释)。钩子抛错不影响回合:
    // collectTurn 的 onEvent 已经把它围起来了,这里也只做一次 Map.set。
    onTurnEvent: (chatId, ev) => { if (ev.kind === 'tool_call') deps.petSignals?.noteToolCall(chatId) },
    // sendAssistantText fallback path: same fall-through the legacy
    // routeInbound used to take when the agent didn't call a reply tool.
    // main.ts injects a real ilink.sendMessage closure; bootstrap.ts only
    // wires the structural piece.
    sendAssistantText,
    // Task 10 — coordinator resolves per-chat tier on every dispatch.
    // loadAccess() reads access.json with a 5s in-process TTL cache, so
    // this is cheap to call per inbound. Admin/trusted/guest classification
    // determines which TierProfile the session is spawned under.
    loadAccess,
    log: deps.log,
    // PR F — chatroom moderator now resolves a provider-agnostic cheap
    // eval via ProviderRegistry.getCheapEval(). Each registered provider
    // implements its own cheapest one-shot LLM call (claude → haiku via
    // SDK query(); codex → ephemeral Thread.run with minimal reasoning).
    // The auth-failed sentinel detection that lived in the prior
    // ./haiku-eval helper moves to a shared agent-provider helper
    // applied at the callsite — so stale creds throw a structured
    // error and the moderator's existing catch branch falls back to
    // forced alternation. Codex-only users no longer hard-fail here.
    haikuEval: wrapCheapEvalWithAuthFailCheck(registry.getCheapEval(), deps.log),
    // /chat beat ③ verdict — the DEFAULT provider's STRONG model (not haiku).
    // Falls back to the cheap eval if that provider has no strongEval, so
    // codex-default deployments still get a verdict.
    verdictEval: wrapCheapEvalWithAuthFailCheck(
      registry.getStrongEval(defaultProviderId) ?? registry.getCheapEval(),
      deps.log,
    ),
  })

  // RFC 03 P4 — bare delegate providers + one-shot dispatcher.
  // See ./delegate.ts for why these are constructed separately from the
  // registry's main providers (no mcpServers — recursion prevention).
  const dispatchDelegate = buildDelegateDispatch({
    stateDir: deps.stateDir,
    log: deps.log,
    ...(claudeBin ? { claudeBin } : {}),
    // 没有 claude 二进制就别把 claude 放进 delegate 名单 —— 与 codex/openai
    // 同一个姿态。上面那条 WARNING 之前只是说说,名单照旧列着它。
    claudeAvailable: !!claudeBin,
    // 版本不同不再拦(见 providers.ts 的 2026-09-09 定案);只有 --version 都打不出来才不给。
    ...(codexBinary && codexVersionCheck && codexVersionCheck.reason !== 'version_probe_failed' ? { codexPathOverride: codexBinary } : {}),
    // busy-registry hold (spec 2026-08-11 §2, Task 4 step 3 + Task 6) —
    // a delegate dispatch is a one-shot session outside SessionManager.
    holdBusy: busyRegistry.hold,
    // 同上:one-shot delegate 失败也采一笔。
    onProviderFailure: (info) => {
      void import('../diagnostics/failure-shapes').then(m => m.recordFailureShape(deps.stateDir, info))
    },
  })

  // ── A2A wiring ────────────────────────────────────────────────────────
  // Instantiate registry, client, events store. These are cheap objects
  // that don't require a2a_listen to be configured — they're also used
  // by POST /v1/a2a/send (outbound calls from the MCP tool).
  const a2aRegistry = createA2ARegistry({ stateDir: deps.stateDir })
  const a2aClient = createA2AClient()
  const a2aEventsStore = makeA2AEventsStore(deps.db)

  // Helper: resolve operator chat. v1 = earliest-updated_at conversation
  // row (first chat the operator ever used; most stable identity).
  //
  // Cache only POSITIVE hits: on a fresh install the conversations table
  // is empty until the operator sends their first WeChat message. If we
  // also cached `null`, every A2A notify that arrived before that first
  // message would be permanently dropped as `dropped_no_operator_chat`
  // — even after the operator binds — until daemon restart.
  let cachedOperatorChatId: string | null = null
  function resolveOperatorChatId(): string | null {
    if (cachedOperatorChatId) return cachedOperatorChatId
    const row = deps.db.query<{ chat_id: string }, []>(
      'SELECT chat_id FROM conversations ORDER BY updated_at ASC LIMIT 1',
    ).get()
    if (row?.chat_id) cachedOperatorChatId = row.chat_id
    return cachedOperatorChatId
  }

  // Single server holder — assigned once wireA2aServer builds it below.
  // (曾经有一条注释说 wireSocial 的 getServerBaseUrl thunk 闭包在这上面、
  // 所以顺序要紧。那个 dep 从头到尾没被 wireSocial 用过,注释比死代码更贵
  // —— 它会让后来的人以为这里的顺序是有约束的。一并删掉。)
  let a2aServer: import('../../core/a2a-server').A2AServer | null = null

  // 降级兜底:social 抛错时的 inert wiring — 与 wireSocial 未配置时的内部
  // 状态同形(全 handler undefined),下游 a2a/mailbox/return 的门原样生效。
  const inertSocialWiring: import('./wire-social').SocialWiring = {
    onLetter: undefined,
  }
  const socialWiring = (await sup.start('social', async () => {
    const w = await wireSocial({
      log: deps.log,
      stateDir: deps.stateDir,
      sendFile: deps.ilink.sendFile ? (c, p) => deps.ilink.sendFile!(c, p) : undefined,
      db: deps.db,
      configuredAgent,
      selfId,
      registry,
      defaultProviderId,
      resolveOperatorChatId,
      sendAssistantText,
      a2aRegistry,
      a2aClient,
      knowledge,
      // 串门 / 答心愿是脱离会话的后台模型活 —— 登记进 busy,空闲自动重启
      // 才不会掐在半程(和 delegate 的 'a2a-delegate' 同一个理由)。
      holdBusy: busyRegistry.hold,
    })
    // 未配置 / 无 cheapEval ⇒ wireSocial 返回 inert 对象(social 字段缺席)
    // ⇒ 映射为 null ⇒ supervisor 记 off。
    return w.social ? w : null
  })) ?? inertSocialWiring
  socialWired.set(!!socialWiring.social)

  const a2aWiring = await sup.start('a2a-server', () => wireA2aServer({
    log: deps.log,
    stateDir: deps.stateDir,
    configuredAgent,
    a2aRegistry,
    a2aClient,
    a2aEventsStore,
    dispatchDelegate,
    resolveOperatorChatId,
    sendAssistantText,
    onLetter: socialWiring.onLetter,
  }))
  const a2aDeps = a2aWiring?.a2aDeps
  a2aServer = a2aWiring?.a2aServer ?? null

  // 配对码 (pairing-code design §7) — the daemon-side pairing engine. Gated
  // ONLY on mailbox_relays (rendezvous needs a relay); independent of
  // social_enabled — a daemon can pair without social being on. `selfId` is
  // the SAME constant resolved once above; `url` advertises this daemon's
  // own a2a_listen base (undefined ⇒ a pure NAT'd, url-less mailbox peer).
  // Undefined when mailbox_relays is unconfigured — the WeChat「配对」dispatch
  // seam and internal-api /v1/pair/* routes then stay inert, same posture
  // as boot.social/boot.penpal.
  const pairingEngine = await sup.start('pairing', () => wirePairing({
    stateDir: deps.stateDir,
    configuredAgent,
    a2aRegistry,
    db: deps.db,
    selfId,
    url: a2aServer ? a2aServer.baseUrl() : undefined,
    notify: (msg) => { const op = resolveOperatorChatId(); if (op && sendAssistantText) void sendAssistantText(op, msg) },
    log: deps.log,
  }))

  // Content-blind mailbox transport (sub-project B, Task 8) — the poller's
  // deps, constructed only when social wiring is live AND at least one relay
  // is configured. main.ts mounts `registerMailboxPoller(mailboxPollerDeps)`
  // on the companion scheduler iff this is present; otherwise the feature
  // stays fully inert (no poll timer, no relay traffic). I1: `onMailboxLetter`
  // is `socialWiring.onMailboxLetter` (own-channel-only) — the only inbound
  // arm a bearer-less mailbox drop may reach.
  const mailboxRelays = configuredAgent.mailbox_relays ?? []
  const mailboxPollerDeps = (configuredAgent.social_enabled && mailboxRelays.length > 0 && socialWiring.onMailboxLetter)
    ? {
        stateDir: deps.stateDir,
        a2aRegistry,
        onMailboxLetter: socialWiring.onMailboxLetter,
        relays: mailboxRelays,
        // Re-checked at every tick (mtime-cached read) so a `/set` toggle of
        // social_enabled takes effect without a daemon restart, same posture
        // as the companion schedulers' shouldRun gates.
        shouldRun: () => readAgentConfig().social_enabled === true,
        log: deps.log,
      }
    : undefined

  // ── 乙 v2 wiring (guarded — no-op when config absent) ────────────────────
  // BRAIN side: start a WebSocket rendezvous that hands connect to.
  let yiHub: YiHub | undefined
  if ((configuredAgent as { yi_hub_listen?: { host: string; port: number } }).yi_hub_listen) {
    const cfg = (configuredAgent as { yi_hub_listen: { host: string; port: number } }).yi_hub_listen
    yiHub = createYiHub()
    const yiServer = createYiWsServer({
      host: cfg.host,
      port: cfg.port,
      hub: yiHub,
      verify: (id, tok) => !!a2aRegistry.verifyBearer(id, tok),
    })
    await yiServer.start()
    deps.log('YI', `hub listening on ws://${cfg.host}:${yiServer.port()}`)
  }

  // HAND side: connect outbound to a brain's rendezvous.
  if ((configuredAgent as { yi_brain?: { url: string; handId: string; authToken: string } }).yi_brain) {
    const cfg = (configuredAgent as { yi_brain: { url: string; handId: string; authToken: string } }).yi_brain
    const { createYiWsClient } = await import('../yi-ws-client')
    const yiClient = createYiWsClient({
      brainUrl: cfg.url,
      handId: cfg.handId,
      authToken: cfg.authToken,
      capabilities: ['exec'],
      onExec: (t) => dispatchDelegate(t.peer, t.prompt, t.cwd),
      log: (m) => deps.log('YI', m),
    })
    yiClient.start()
    deps.log('YI', `hand connecting to brain at ${cfg.url}`)
  }

  return {
    sessionManager,
    sessionStore,
    conversationStore,
    registry,
    coordinator,
    resolve,
    formatInbound,
    sdkOptionsForProject,
    buildInstructions,
    defaultProviderId,
    codeHead: wiredSelfRestart?.loadedHead ?? null,
    providerNotes: () => {
      const out: Partial<Record<ProviderId, string>> = { ...baseProviderNotes() }
      for (const [id, note] of anomalyNotes) out[id] = out[id] ? `${out[id]} · ⚠️ ${note}` : `⚠️ ${note}`
      return out
    },
    agentProviderKind: defaultProviderId,
    /**
     * RFC 03 P4 — late-bound into internal-api by main.ts after
     * buildBootstrap returns. The route is 503 until that wiring lands.
     */
    dispatchDelegate,
    ...(a2aDeps ? { a2aDeps } : {}),
    a2aServer,
    yiHub,
    agentConfig: configuredAgent,
    sendAssistantText,
    /**
     * spec §2 (pairing-code design) — this daemon's stable-unique self slug,
     * resolved once above. Shared by wireSocial + wirePairing + (via this
     * field) pipeline-deps' exec/hands delegate path — see the doc comment
     * on Bootstrap['selfId'] in ./types.ts.
     */
    selfId,
    /**
     * 社交面(笔友信道 + 心愿)— late-bound into internal-api by main.ts
     * (mirrors a2aDeps/setA2A). Undefined when social_enabled +
     * social_disclosure_policy aren't both configured — POST
     * /v1/social/wish then 503s.
     */
    ...(socialWiring.social ? { social: socialWiring.social } : {}),
    /**
     * Anonymous pen-pal channel (Task 8/10/11) — the "回信 <channel> <text>"
     * dispatch seam in pipeline-deps.ts reads this directly (not
     * boot.social.penpal). Undefined whenever social wiring is inert, same
     * gate as boot.social.
     */
    ...(socialWiring.social ? { penpal: socialWiring.social.penpal } : {}),
    /**
     * Content-blind mailbox transport (Task 8) — present only when
     * social_enabled + at least one mailbox_relays entry are configured.
     * main.ts mounts the poller lifecycle iff this is set.
     */
    ...(mailboxPollerDeps ? { mailboxPollerDeps } : {}),
    /**
     * 配对码 (spec §7) — undefined when mailbox_relays isn't configured;
     * see Bootstrap['pairing']'s doc comment in ./types.ts.
     */
    ...(pairingEngine ? { pairing: pairingEngine } : {}),
    /**
     * Knowledge Kernel (Phase 01, T5) — undefined when `knowledge_enabled`
     * is not configured; see Bootstrap['knowledge']'s doc comment in
     * ./types.ts.
     */
    ...(knowledge ? { knowledge } : {}),
    /**
     * Connection-health runtime (Task 7) — see ./wire-health.ts and the
     * doc comment on Bootstrap['health'] in ./types.ts.
     */
    health,
    /**
     * busy-registry hold (spec 2026-08-11 §2) — see Bootstrap['holdBusy']'s
     * doc comment in ./types.ts. Always present (busyRegistry is
     * constructed unconditionally above, independent of whether
     * self-restart itself is enabled).
     */
    holdBusy: busyRegistry.hold,
    /** busy-registry label 快照(spec 2026-09-03-companion-presence)。 */
    busyLabels: busyRegistry.labels,
    /**
     * self-restart (spec 2026-08-03-daemon-self-restart-on-stale-code) —
     * undefined when deps.requestRestart wasn't provided (mechanism fully
     * inert); see Bootstrap['markInboundActivity']'s doc comment in
     * ./types.ts. main.ts's wireMain wires `.mark` into mw-messages'
     * markInboundActivity via pipeline-deps' `messages` dep.
     */
    ...(selfRestartActivityMarker ? { markInboundActivity: selfRestartActivityMarker.mark } : {}),
  }
}
