/**
 * 协调器对外的形状:依赖、对外接口、每一轮的结构化记录。只有类型,没有逻辑。
 */
import type { SessionManager } from '../session-manager'
import type { ConversationStore } from '../../ports/conversation-store'
import type { ProviderRegistry } from '../provider-registry'
import type { Mode, ProviderId } from '../../domain/conversation'
import type { InboundMsg } from '../../domain/prompt-format'
import type { HandoffTurn } from '../../domain/provider-handoff'
import type { PermissionMode } from '../../domain/capability-matrix'
import type { DeliveryKind, ReplyDeliveryPort, ReplyTextStrategy } from '../../domain/turn-reply'
import type { AgentEvent } from '../../ports/agent-provider'
import type { Access } from '../../lib/access'
import type { NetworkGate } from '../../lib/network-gate'

import type { TurnRecord } from '../../domain/turn-record'
export type { TurnRecord }

export interface ConversationCoordinatorDeps {
  resolveProject(chatId: string): { alias: string; path: string } | null
  manager: Pick<SessionManager, 'acquire'> & Partial<Pick<SessionManager, 'release' | 'releaseFor' | 'has' | 'effectiveTarget'>>
  conversationStore: Pick<ConversationStore, 'get' | 'set' | 'setParticipants'>
  registry: Pick<ProviderRegistry, 'has' | 'list' | 'get'>
  /**
   * Default provider id for chats with no explicit Mode set. Mirrors
   * the daemon's agent-config.provider — i.e. on a fresh install
   * everything answers under whichever provider the user picked at
   * setup time, until they say `/cc` or `/codex` to override per-chat.
   */
  defaultProviderId: ProviderId
  /**
   * Default provider ids for primary_tool peer validation. Defaults to
   * `['claude', 'codex']` — the two providers shipped before cursor.
   * Used ONLY by validateMode for primary_tool (the peer must be one
   * of these). For parallel/chatroom, the active set is resolved
   * per-dispatch from Mode.participants (or the registry as a fallback)
   * via resolveParticipants — this dep is NOT consulted there.
   */
  parallelProviders?: ProviderId[]
  /**
   * Permission mode — 'strict' (default, per-tool relay) or 'dangerously'
   * (bypass all permission prompts). Computed once at bootstrap from
   * `dangerouslySkipPermissions`. Each chat's effective mode is derived from it
   * (effectivePermissionMode: guests always strict).
   */
  permissionMode: PermissionMode
  /**
   * Per-turn watchdog (ms). When set, every solo turn is bounded: if the
   * agent stream goes silent this long, the turn is abandoned, the wedged
   * session is released (self-heal — next message gets a fresh subprocess),
   * and the user is told to retry. Omit to disable (legacy unbounded
   * behaviour — used by tests that don't exercise the timeout path).
   * Bootstrap wires this from config so the daemon never wedges on a
   * stalled SDK subprocess. See [[TURN_TIMEOUT_CODE]].
   */
  turnTimeoutMs?: number
  /**
   * Per-event observer for every provider event of every turn (solo,
   * parallel, chatroom), tagged with the inbound chat id. Feeds the
   * desktop pet's live "what is it doing" signals — bookkeeping only:
   * `collectTurn` swallows anything it throws, so it can never affect
   * the turn.
   */
  onTurnEvent?: (chatId: string, ev: AgentEvent) => void
  /**
   * Sink for the per-turn structured record (see [[TurnRecord]]). Optional —
   * tests and minimal embeddings can omit it. Bootstrap wires it to a daemon
   * ring buffer surfaced on internal-api for diagnosis/self-healing.
   */
  recordTurn?: (record: TurnRecord) => void
  format: (msg: InboundMsg) => string
  /**
   * 换 provider 交接 (provider-handoff.ts):最近 N 条干净对话,注入切换后
   * 第一条 prompt。缺省 ⇒ 交接块只有提示语,没有近况原文。
   */
  recentTurns?: (chatId: string, n: number) => Promise<HandoffTurn[]>
  /** agent-config `trusted_providers`(非管理员可用的 provider),缺省 = 全部。
   *  读法带 mtime 缓存,/set providers 改完下一条就生效。 */
  trustedProviders?: () => readonly ProviderId[] | undefined
  sendAssistantText?: (chatId: string, text: string) => Promise<unknown>
  /**
   * 系统通知(认证失败 / 超时 / 守护拒绝 / spawn 失败 / 本轮出错 / provider 不可用……,spec §4.3 末段
   * 「系统通知分家」)。和 agent 的话分开:日志里是 NOTICE 而不是 FALLBACK_REPLY,也不进打猎旁听。
   * app 接收器照样接(通知在 app 里也要看得见)。缺省 ⇒ 退回 sendAssistantText(老嵌入 / 测试不变)。
   */
  sendNotice?: (chatId: string, text: string) => Promise<unknown>
  /**
   * 回复交付端口(daemon/reply-delivery.ts)。一轮的最后的话只有这一条路送出去(D3 删掉了 reply 工具说话的旧路),
   * 所以必填:没有它就不可能交付。
   */
  replyDelivery: ReplyDeliveryPort
  /** 每家 provider 哪些文字算回复;缺省读能力表的 `replyTextStrategyFor`。测试注入。 */
  replyTextStrategyFor?: (providerId: ProviderId) => ReplyTextStrategy
  /**
   * 「应答轮交付为空」的连击(spec §4.10,取代当年的 FALLBACK 连击):私聊 / app 一轮 completed 但
   * 什么都没交付(空文字、没附件)或写了 NO_REPLY ⇒ +1;正常交付 ⇒ 0。bootstrap 记进 /mode 并在 ≥3 时打
   * [PROVIDER_ANOMALY]。
   */
  onEmptyReplyStreak?: (providerId: ProviderId, streak: number) => void
  /** 长任务进度的阈值(已定 ①,默认 120 秒):一轮超过它还没结束,daemon 发一次进度。测试注入小值。 */
  replyProgressAfterMs?: number
  /**
   * Optional `fields` arg lands in the JSONL sidecar (channel.log.jsonl)
   * for programmatic consumers. Stubs that don't care can ignore it
   * (third arg is optional in the daemon's real `log` impl too).
   */
  log: (tag: string, line: string, fields?: Record<string, unknown>) => void
  /**
   * One-shot Claude Haiku eval used by the chatroom conductor (beat ②b
   * convergence check and beat ③ verdict). Bootstrap wires this to
   * `query()` from `@anthropic-ai/claude-agent-sdk` with
   * model='claude-haiku-4-5' + maxTurns=1.
   *
   * Optional so existing test fixtures (most don't exercise /chat) don't
   * have to provide a stub. If omitted, beat ②b is skipped and beat ③
   * verdict is not emitted.
   */
  haikuEval?: (prompt: string) => Promise<string>
  /**
   * Strong one-shot eval (the DEFAULT provider's main model) for beat ③'s
   * verdict — synthesis quality matters more than cost there. Optional;
   * falls back to {@link haikuEval} when absent. The cheaper haikuEval still
   * powers the tiny beat ②b convergence check.
   */
  verdictEval?: (prompt: string) => Promise<string>
  /**
   * Throttle window (ms) for the per-provider "登录已过期" notice the coordinator
   * emits when a provider reports `errorCode: 'auth_failed'`. The first
   * failure in a chat sends one notice; further failures within this
   * window are silent (avoids spamming the user while their AI session
   * is broken). Default: 60 min.
   */
  authFailNotifyThrottleMs?: number
  /**
   * Clock injection — used by the auth-failed notice throttle so tests
   * can drive virtual time without `vi.useFakeTimers()`. Defaults to
   * `Date.now`.
   */
  now?: () => number
  /**
   * Loads the current access.json snapshot. Called once per dispatch to
   * resolve the inbound chatId's tier (`resolveTier(chatId, access)`) →
   * `TIER_PROFILES[tier]` → handed to `manager.acquire({tierProfile})`.
   * The real impl (src/lib/access.ts) maintains a 5s TTL cache so this
   * is cheap to call per message; tests can pass a constant lambda.
   */
  loadAccess: () => Access
  /**
   * 网络闸门(守护 v2)。每一轮在碰 provider 之前,按这一轮**要用的 provider + 模型**分类:
   * 需要保护且网络不安全的不出发,用 sendAssistantText 回一句统一的话(微信 / App / 手机都
   * 走这条,按 reply sink 落到发起的那一面),不重试;不需要保护的照常。多人模式里只拿掉
   * 被挡的那几位,其余照常发言。缺省 = 不拦。
   */
  networkGate?: NetworkGate
}

/** Turn-taking policy for a mode (D3 — turn-entry unification). */
export type TurnPolicy = 'queue' | 'preempt'

export interface ConversationCoordinator {
  /**
   * The SINGLE turn entrypoint (D3). Owns the per-chat turn-taking policy
   * (queue vs preempt, via {@link turnPolicy}) AND the dispatch itself, so a
   * caller can never take the wrong lock or bypass it. `opts.within` runs
   * caller logic (e.g. an app reply-sink capture) INSIDE the locked/preempt
   * turn; it receives an opaque `dispatch` closure it must await — the only
   * way to trigger the turn (so callers never name the internal dispatch).
   */
  submitTurn(msg: InboundMsg): Promise<void>
  submitTurn<T>(msg: InboundMsg, opts: { within: (dispatch: () => Promise<void>) => Promise<T> }): Promise<T>
  dispatch(msg: InboundMsg): Promise<void>
  /**
   * Per-chatId async mutex (Task 1 — session-serialization): runs `fn`
   * exclusively with respect to any other `runExclusive` call for the same
   * chatId, so two rapid inbound messages for one chat can never run their
   * turns concurrently (session/history races). Different chatIds are
   * independent. Exposed mainly for tests; `dispatch` is the normal caller.
   */
  runExclusive<T>(chatId: string, fn: () => Promise<T>): Promise<T>
  /**
   * Get the effective mode for a chat — persisted value, or the daemon
   * default if none. Used by mode-commands to render `/mode` status.
   */
  getMode(chatId: string): Mode
  /**
   * Set the mode for a chat. Validates that any ProviderId mentioned in
   * the mode is actually registered. As a side effect: clears any
   * chatroom-specific per-chat memory when the chat exits chatroom
   * (RFC 03 review #3 partial — full session release is left to LRU /
   * idle eviction because the (alias, providerId) key is shared across
   * chats and per-chat release would leak across boundaries).
   */
  setMode(chatId: string, mode: Mode): void
  /**
   * Abort an in-flight chatroom dispatch loop for this chat (RFC 03
   * review #11). Returns true iff a loop was actually in flight and
   * was signalled. Other-mode dispatches are not preemptable (they're
   * single-turn).
   */
  cancel(chatId: string): boolean
}
