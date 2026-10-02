/**
 * wire-coordinator.ts — sendAssistantText(fallback 回复)、recordTurn(回合记录)、
 * ConversationCoordinator,以及 chatroom 用的 cheap-eval 包装。从 bootstrap/index.ts
 * 逐字搬出(2026-09-27 bootstrap 拆分,spec 2026-09-27-bootstrap-split-design);
 * 块内逻辑与注释不变,只参数化:deps.db → ctx.db;index 里的 resolve / sessionManager /
 * conversationStore / registry / defaultProviderId / readAgentConfig / permissionMode /
 * turnTimeoutMs / health 走 parts.*。anomalyNotes 随块搬进来,index 用它拼 providerNotes。
 */
import { createConversationCoordinator, type ConversationCoordinator, type TurnRecord } from '../../core/conversation-coordinator'
import type { ConversationStore } from '../../core/conversation-store'
import type { ProviderRegistry } from '../../core/provider-registry'
import type { ProviderId } from '../../core/conversation'
import type { PermissionMode } from '../../core/capability-matrix'
import { formatInbound } from '../../core/prompt-format'
import { makeMessagesStore } from '../../lib/messages-store'
import { loadAccess } from '../../lib/access'
import { assertNotAuthFailed, type CheapEval } from '../../core/agent-provider'
import type { SessionManager } from '../../core/session-manager'
import type { HealthRuntime } from '../health'
import { shouldNoteTurnEnd } from '../pet-signals'
import { makeSendAssistantText } from './fallback-reply'
import { reportLlmTurnOutcome } from './wire-health'
import type { Bootstrap, BootstrapDeps, BootstrapCtx } from './types'
import type { ModelOptionsSlice } from './wire-model-options'

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

export interface CoordinatorSlice {
  anomalyNotes: Map<ProviderId, string>
  sendAssistantText: Bootstrap['sendAssistantText']
  coordinator: ConversationCoordinator
}

export function wireCoordinator(
  deps: Pick<BootstrapDeps, 'ilink' | 'log' | 'onTurnRecord' | 'petSignals' | 'replySinks' | 'outboundTaps' | 'networkGate'>,
  ctx: Pick<BootstrapCtx, 'db'>,
  parts: {
    health: HealthRuntime
    resolve: Bootstrap['resolve']
    sessionManager: SessionManager
    conversationStore: ConversationStore
    registry: ProviderRegistry
    defaultProviderId: ProviderId
    readAgentConfig: ModelOptionsSlice['readAgentConfig']
    permissionMode: PermissionMode
    turnTimeoutMs: number
  },
): CoordinatorSlice {
  // provider 异常备注(fallback 连击),与 providers.ts 的版本/探测备注合并进 /mode。
  const anomalyNotes = new Map<ProviderId, string>()

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
    reportLlmTurnOutcome(parts.health, record.outcome, record.error)
    // 桌宠(spec 2026-09-05-cc-desktop-pet §5.1)—— 回合结束的那一刻。recordTurn
    // 是唯一一处**每种结局都会经过**的窄点,所以「刚忙完」用它的 endedAt,而不是
    // 任何一条成功路径上的时间。但不是每条记录都算一次「忙完」:哪些算,判据写在
    // shouldNoteTurnEnd 里(只认 completed;chatroom 每participant每拍一条,得排除)。
    if (shouldNoteTurnEnd(record)) deps.petSignals?.noteTurnEnd(record.chatId, record.endedAt)
  }

  const handoffMessages = makeMessagesStore(ctx.db)
  const coordinator = createConversationCoordinator({
    resolveProject: parts.resolve,
    manager: parts.sessionManager,
    conversationStore: parts.conversationStore,
    registry: parts.registry,
    defaultProviderId: parts.defaultProviderId,
    format: formatInbound,
    // 换 provider 交接的近况原文 — 消息库最近 n 条(text 类为主,升序)。
    // 非管理员可用的 provider 允许表(core/provider-policy.ts),mtime 缓存读。
    trustedProviders: () => parts.readAgentConfig().trusted_providers,
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
    permissionMode: parts.permissionMode,
    turnTimeoutMs: parts.turnTimeoutMs,
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
    // 网络闸门(2026-10-02):每一轮先问,不安全就回一句统一的话、不出发。
    ...(deps.networkGate ? { networkGate: deps.networkGate } : {}),
    // PR F — chatroom moderator now resolves a provider-agnostic cheap
    // eval via ProviderRegistry.getCheapEval(). Each registered provider
    // implements its own cheapest one-shot LLM call (claude → haiku via
    // SDK query(); codex → ephemeral Thread.run with minimal reasoning).
    // The auth-failed sentinel detection that lived in the prior
    // ./haiku-eval helper moves to a shared agent-provider helper
    // applied at the callsite — so stale creds throw a structured
    // error and the moderator's existing catch branch falls back to
    // forced alternation. Codex-only users no longer hard-fail here.
    haikuEval: wrapCheapEvalWithAuthFailCheck(parts.registry.getCheapEval(), deps.log),
    // /chat beat ③ verdict — the DEFAULT provider's STRONG model (not haiku).
    // Falls back to the cheap eval if that provider has no strongEval, so
    // codex-default deployments still get a verdict.
    verdictEval: wrapCheapEvalWithAuthFailCheck(
      parts.registry.getStrongEval(parts.defaultProviderId) ?? parts.registry.getCheapEval(),
      deps.log,
    ),
  })

  return { anomalyNotes, sendAssistantText, coordinator }
}
