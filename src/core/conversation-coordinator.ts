/**
 * conversation-coordinator — replaces the straight-line routeInbound
 * with mode-aware dispatch (RFC 03 §3.2 / §4).
 *
 * For each inbound, the coordinator:
 *   1. Resolves the chat's project alias via the project resolver.
 *   2. Looks up the chat's persisted Mode (or falls back to the daemon
 *      default — a solo mode using the bootstrap-time provider).
 *   3. Acquires the participant session(s) from SessionManager keyed by
 *      (provider, alias).
 *   4. Dispatches per the mode's semantics.
 *
 * All Mode variants are implemented: `solo` (single provider), `parallel`
 * (`/both` — concurrent replies), `primary_tool` (`/cc + codex` — one drives,
 * the other is exposed as a tool), and `chatroom` (`/chat` — moderated
 * round-table).
 */
import type { SessionManager } from './session-manager'
import type { ConversationStore } from './conversation-store'
import { providerCallTarget, type ProviderRegistry } from './provider-registry'
import type { Mode, ProviderId } from './conversation'
import type { InboundMsg } from './prompt-format'
import { makeHandoffLedger, buildHandoffBlock, buildColdStartBlock, type HandoffTurn } from './provider-handoff'
import { providerDenialFor, describeProviderDenial, slashFor } from './provider-policy'
import {
  buildOpeningPrompt, buildRebuttalPrompt, buildVerdictPrompt, buildConvergencePrompt, parseConvergence,
  labelOpenings, buildContentionPrompt, parseContention, lensFor,
  parsePeerRank, aggregateRanking, formatRankingFooter, buildParallelSynthesisPrompt,
  type Opening, type Contention, type RankedSpeaker,
} from './chatroom-conductor'
import { assertSupported, capabilitiesFor, replyDeliveryFor, replyTextStrategyFor, UnsupportedCombinationError, type PermissionMode } from './capability-matrix'
import { buildTurnReply, makeTurnTextCollector, type DeliveryKind, type DeliveryReport, type ReplyDeliveryMode, type ReplyDeliveryPort, type ReplyTextStrategy, type TurnDeliveryHandle } from './turn-reply'
import { collectTurn, TURN_TIMEOUT_CODE, type AgentEvent, type TurnSummary } from './agent-provider'
import { isAuthErrorCode, providerErrorCodeOf } from '../lib/provider-error-code'
import { resolveEffectiveTier, resolveTier, TIER_PROFILES, type TierProfile } from './user-tier'
import type { Access } from '../lib/access'
import { decideCall, unprotectedMessage, type NetworkGate } from '../lib/network-gate'
import { makeChatMutex } from './async-mutex'

/**
 * Per-agent timeout for a single /chat debate beat. Much shorter than the
 * daemon-wide turn watchdog (default 10 min, tuned for long solo coding turns):
 * a chatroom beat is one opening/rebuttal, and a wedged or silent agent must
 * fail fast (→ self-heal + graceful degrade) rather than make the user wait
 * minutes for a reply. Capped via Math.min so a smaller daemon turnTimeoutMs
 * (e.g. in tests) still wins.
 */
const CHATROOM_BEAT_TIMEOUT_MS = 120_000

/** 已定 ①:一轮超过 120 秒还没结束,daemon 发一次进度(微信里;app 那头本来就看得见旁白)。 */
const LONG_TURN_PROGRESS_MS = 120_000
/** 还没写过任何旁白时的进度文案。 */
export const LONG_TURN_PROGRESS = '还在弄,有点久,好了告诉你'

/**
 * Structured, per-turn outcome record — the AI-native observability surface.
 * Emitted via `ConversationCoordinatorDeps.recordTurn`: once per solo dispatch,
 * once per participant in `parallel` mode, and once per speaker turn (round)
 * in `chatroom` mode — `mode` distinguishes them.
 * The daemon stores a ring of these (and/or exposes them on internal-api) so
 * a human — or an LLM diagnosing the daemon — can answer "what happened to
 * this chat's last turn" without grepping free-text logs. `outcome` is the
 * causal verdict; `error` carries the detail for `timeout`/`error` cases.
 */
export interface TurnRecord {
  chatId: string
  provider: ProviderId
  alias: string
  mode: Mode['kind']
  /** Epoch ms when the dispatch began (clock from `deps.now`). */
  startedAt: number
  /** Epoch ms when the dispatch settled. */
  endedAt: number
  durationMs: number
  outcome: 'completed' | 'timeout' | 'auth_failed' | 'error'
  replyToolCalled: boolean
  /** 这一轮调过的工具名(只有名字,不含参数)。空数组 = 这条回答没查任何东西。 */
  toolCalls?: string[]
  /** Count of assistant text chunks produced this turn. */
  textChunks: number
  /** Failure detail for `timeout` / `error` outcomes; undefined otherwise. */
  error?: string
  /** provider 边界产的结构化码(lib/provider-error-code;`turn_timeout` 也在这)。
   *  health 判定有码就只看码,不再扫 `error` 文本。 */
  errorCode?: string
  /**
   * 回复交付(spec 2026-10-03 §4.10):这一轮主人到底收到了什么。只有 daemon 模式的轮才填;legacy /
   * shadow 的轮留空(那时「说没说话」由 reply 工具决定,记在 replyToolCalled)。
   */
  delivery?: DeliveryKind
  /** 发出的文字气泡条数(交给 app 接收器的非空文字算 1)。 */
  bubbles?: number
  /** 发出的附件数(语音 / 表情 / 文件)。 */
  attachments?: number
  /** 最后的话之前的旁白段数(不发微信)。 */
  narrationSegments?: number
}

/**
 * TurnRecord 的交付列 —— solo、/both、/chat 三处同一个写法(spec §4.10)。只有真的交付过(daemon 模式、
 * completed)才有 report;legacy / shadow / 出错的轮不填。
 */
function deliveryColumns(
  report: DeliveryReport | undefined,
  summary: Pick<TurnSummary, 'narration'> | undefined,
): Pick<TurnRecord, 'delivery' | 'bubbles' | 'attachments' | 'narrationSegments'> {
  if (!report) return {}
  return {
    delivery: report.delivery,
    bubbles: report.bubbles,
    attachments: report.attachmentsSent,
    narrationSegments: summary?.narration?.length ?? 0,
  }
}

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
   * `dangerouslySkipPermissions`. Threaded into assertSupported() at
   * dispatch entry and used by capability-matrix to gate combinations.
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
  /**
   * 某 provider **连续**几轮走了 FALLBACK_REPLY(有文字、零 reply 工具)。
   * 0 = 这轮正常调了 reply,连击清零。外部 CLI(agy/cursor)的流格式一变,
   * tool_call 就解析不出来,双发旁白悄悄回来 —— 2026-09-08 靠主人截图才发现。
   * 这个钩子把「静默」变「可见」:bootstrap 记进 /mode 并打 [PROVIDER_ANOMALY]。
   */
  onFallbackStreak?: (providerId: ProviderId, streak: number) => void
  sendAssistantText?: (chatId: string, text: string) => Promise<void>
  /**
   * 系统通知(认证失败 / 超时 / 守护拒绝 / spawn 失败 / 本轮出错 / provider 不可用……,spec §4.3 末段
   * 「系统通知分家」)。和 agent 的话分开:日志里是 NOTICE 而不是 FALLBACK_REPLY,也不进打猎旁听。
   * app 接收器照样接(通知在 app 里也要看得见)。缺省 ⇒ 退回 sendAssistantText(老嵌入 / 测试不变)。
   */
  sendNotice?: (chatId: string, text: string) => Promise<void>
  /**
   * 回复交付端口(daemon/reply-delivery.ts)。shadow / daemon 模式的 provider 才用到;缺省 ⇒ 一律按
   * legacy 走(没有端口就不可能交付)。
   */
  replyDelivery?: ReplyDeliveryPort
  /** 每家 provider 的交付模式;缺省读 capability-matrix 的 `replyDeliveryFor`。测试 / 实验可以注入。 */
  replyDeliveryModeFor?: (providerId: ProviderId) => ReplyDeliveryMode
  /** 每家 provider 哪些文字算回复;缺省读能力表的 `replyTextStrategyFor`。测试注入。 */
  replyTextStrategyFor?: (providerId: ProviderId) => ReplyTextStrategy
  /**
   * daemon 模式下「应答轮交付为空」的连击(spec §4.10,取代 FALLBACK 连击):私聊 / app 一轮 completed 但
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

/** User-facing notice when a provider reports an auth failure.
 *  `auth_failed`(默认):the user already authenticated once; the session
 *  lapsed and they need to re-run the provider's login command on the same
 *  machine.
 *  `auth_rejected`:凭证被 API 拒了(401/403),但**没有**证据说是登录过期 ——
 *  红线 A(owner 2026-10-02 细化):这时不许说「登录过期 / 重新登录」。 */
export function authFailNotice(providerId: ProviderId, code: string = 'auth_failed'): string {
  if (code === 'auth_rejected') {
    return `我这会儿够不着自己的脑子了:${providerId} 认证没通过(API 返回 401/403)。请主人在电脑上检查一下账号或密钥,弄好之后再发我一条,我就回来了。`
  }
  const hint = capabilitiesFor(providerId).authFailHint
  return hint
    ? `我这会儿够不着自己的脑子了,${providerId} 的登录好像过期了。\n${hint}\n弄好之后再发我一条,我就回来了。`
    : `我这会儿够不着自己的脑子了,${providerId} 的登录好像过期了。让主人在电脑上重新登录一下,再发我一条,我就回来了。`
}

/** User-facing notice when a turn dies with a GENERIC error and produced no
 *  reply at all (owner 2026-08-25: 「用户发你好,应该有个回复,比如大脑还未
 *  接入」— silence reads as being ignored). Two flavors: a spawn/missing-
 *  binary shape means the brain was never hooked up; anything else is a
 *  transient hiccup. Both point at the desktop 大脑 card, in CC's voice. */
/** spawn 阶段的失败(不是回合中途):探测没过 / 二进制不在。把 provider 自己
 *  给的人话原样带上 —— first-use-probe 的 failureMessage 就是写给用户看的。 */
/**
 * provider 边界产的码 → 给主人的一句**老实的原因**(arch backlog #4 第 2 步)。
 * 只按码说话,不读错误原文;认证两码不在这里(它们走 authFailNotice,措辞按红线 A 分)。
 * 没码 / 码说不出具体原因 ⇒ undefined,调用方用原来的通用说法。
 */
export function providerFailureReason(providerId: ProviderId, code: string | undefined): string | undefined {
  switch (code) {
    case 'network': return `这条没接住:连不上 ${providerId} 的服务(网络问题,不是你的消息有问题)。网络好了再发我一次就行。`
    case 'server_error': return `这条没接住:${providerId} 的服务那边出错了(服务端 5xx),通常过一会儿自己会好,稍后再发我一次。`
    case 'rate_limited': return `这条没接住:${providerId} 暂时限流了,等几分钟再发我一次。`
    case 'quota': return `这条没接住:${providerId} 的额度用完了。等额度恢复,或者先换一个脑子(比如 /cc)。`
    default: return undefined
  }
}

export function spawnFailedNotice(providerId: ProviderId, detail: string, code?: string): string {
  const head = `❌ ${providerId} 这次没起来,这条我没接住。`
  const reason = providerFailureReason(providerId, code)
  if (reason) return `${head}${reason.replace(/^这条没接住:/, '')}\n先 /cc 用 Claude 也行。`
  const d = detail.trim()
  if (/enoent|not found|no such file|not installed/i.test(d)) return `${head}它好像还没在电脑上接好 —— 主人在「此刻」页的大脑卡里帮我接上,或者 /cc 先用 Claude。`
  return `${head}${d.length > 0 ? d.slice(0, 300) : ''}\n先 /cc 用 Claude 也行。`
}

export function turnErrorNotice(providerId: ProviderId, error: string | undefined, code?: string): string {
  const reason = providerFailureReason(providerId, code)
  if (reason) return reason
  const e = (error ?? '').toLowerCase()
  if (/enoent|not found|no such file|spawn|not installed/.test(e)) {
    return `这条我收到了,但没想起来怎么回——我的脑子(${providerId})好像还没在电脑上接好。麻烦主人打开 wechat-cc,在「此刻」页点一下大脑卡帮我接上,弄好再发我一条就行。`
  }
  return `刚刚脑子卡了一下,这条没接住…过一会儿再发我一次?老是这样的话,让主人在电脑上看看「此刻」页的大脑卡。`
}

/** Turn-taking policy for a mode (D3 — turn-entry unification). */
export type TurnPolicy = 'queue' | 'preempt'

/**
 * The per-chat serialization strategy for a mode, made EXPLICIT (D3):
 *  - `queue`: turns serialize on the per-chat mutex (solo/parallel/primary_tool)
 *    — single-turn dispatches with no self-preemption, so wrapping them in the
 *    mutex is a pure win: two rapid inbound messages for one chat run their
 *    turns one at a time instead of racing on session/history state.
 *  - `preempt`: a new turn aborts the in-flight one (chatroom's latest-wins;
 *    the shape a future voice channel needs for barge-in). Chatroom is EXEMPT
 *    from the mutex because `dispatchChatroom` implements its OWN
 *    preempt-on-arrival protocol (inFlightAborters / inFlightDispatchPromises):
 *    a new message aborts the prior in-flight loop and awaits its cleanup rather
 *    than running it to completion. Routing it through the mutex would make a
 *    new message wait for the lock — handed over only after the PRIOR dispatch
 *    fully settles — before it could even reach the preempt-abort check, turning
 *    "abort the stale loop and start now" into "wait for the stale loop to
 *    drain, THEN start" and defeating latest-wins. (Verified pre-D3 by
 *    temporarily routing chatroom through the mutex: no deadlock, but the abort
 *    never fired early — B just waited behind A's held lock.)
 * Adding a preempt mode is a one-line entry here, not a re-derivation across callers.
 */
export function turnPolicy(mode: Mode): TurnPolicy {
  return mode.kind === 'chatroom' ? 'preempt' : 'queue'
}

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

export function createConversationCoordinator(deps: ConversationCoordinatorDeps): ConversationCoordinator {
  // 换 provider 不断片 — setMode 标记,下一次 solo dispatch 取用(取即清)。
  const handoffLedger = makeHandoffLedger()
  // 每家 provider 连续走 fallback 的轮数(见 deps.onFallbackStreak)。
  const fallbackStreak = new Map<ProviderId, number>()
  // 每家 provider 连续「应答轮交付为空」的轮数(daemon 模式,见 deps.onEmptyReplyStreak)。
  const emptyReplyStreak = new Map<ProviderId, number>()
  const noteDelivery = (providerId: ProviderId, delivery: DeliveryKind): void => {
    const empty = delivery === 'empty' || delivery === 'silent'
    const prev = emptyReplyStreak.get(providerId) ?? 0
    if (!empty) {
      if (prev > 0) { emptyReplyStreak.set(providerId, 0); deps.onEmptyReplyStreak?.(providerId, 0) }
      return
    }
    emptyReplyStreak.set(providerId, prev + 1)
    deps.onEmptyReplyStreak?.(providerId, prev + 1)
  }
  /** 系统通知走 sendNotice(没接就退回 sendAssistantText)—— 与 agent 的话分家(spec §4.3)。 */
  const notice = (chatId: string, text: string): Promise<void> | undefined =>
    (deps.sendNotice ?? deps.sendAssistantText)?.(chatId, text)
  /** 这一轮这家 provider 的交付模式。没有端口 ⇒ 只能 legacy。 */
  const deliveryModeFor = (providerId: ProviderId): ReplyDeliveryMode =>
    deps.replyDelivery ? (deps.replyDeliveryModeFor ?? replyDeliveryFor)(providerId) : 'legacy'
  const textStrategyFor = (providerId: ProviderId): ReplyTextStrategy => (deps.replyTextStrategyFor ?? replyTextStrategyFor)(providerId)
  function defaultMode(): Mode {
    return { kind: 'solo', provider: deps.defaultProviderId }
  }

  function getMode(chatId: string): Mode {
    const persisted = deps.conversationStore.get(chatId)
    return persisted?.mode ?? defaultMode()
  }

  const parallelProviders: ProviderId[] = deps.parallelProviders ?? ['claude', 'codex']

  /**
   * Resolve the active participant set for a parallel/chatroom dispatch.
   *
   * Priority:
   *   1. Explicit mode.participants (the user wrote `/chat claude codex cursor`).
   *   2. Legacy backfill — chat row pre-dates the participants column;
   *      use the first 2 registered providers and persist so the user's
   *      "this chat was 2-way" expectation survives a future operator
   *      install of a 3rd provider.
   *   3. Fresh-chat fallback — no row yet; use the full registry.list().
   *
   * Then filter against the current registry (silently drop providers
   * that vanished from the registry post-persist), and hard-cap at 3
   * in P1 with a log warning if exceeded.
   *
   * Returns the resolved list (≥0 elements). Caller is responsible for
   * the ≤1 → solo+default degradation; this helper does not throw.
   */
  function resolveParticipants(
    mode: (Mode & { kind: 'parallel' | 'chatroom' }),
    chatId: string,
  ): ProviderId[] {
    // agy final-review CRITICAL 1: never let a registry-derived fallback
    // auto-include agy — `deps.registry.list()` is the live provider set
    // and agy is a normal registered provider there (it just can't ride
    // parallel/chatroom, spec §7). Excluded up front so both the legacy
    // backfill (first-two) and the fresh-chat fallback (full registry)
    // never pick it, regardless of registration order.
    const registryList = deps.registry.list().filter(p => p !== 'agy')
    let list: ProviderId[]
    if (mode.participants !== undefined) {
      list = mode.participants
    } else if (deps.conversationStore.get(chatId)?.mode) {
      // Row exists with no participants — legacy. Backfill to first-two.
      list = registryList.slice(0, 2)
      // Persist so this is a one-shot. setParticipants is a no-op if the
      // row doesn't have parallel/chatroom kind, but we just read it as
      // parallel/chatroom so the call is safe.
      try {
        deps.conversationStore.setParticipants(chatId, list)
        deps.log('COORDINATOR', `chat=${chatId} legacy ${mode.kind} backfilled participants=${list.join(',')}`)
      } catch (err) {
        deps.log('COORDINATOR', `chat=${chatId} setParticipants failed: ${err instanceof Error ? err.message : err}`)
      }
    } else {
      // No row yet — first-ever dispatch in this chat under parallel/chatroom.
      list = registryList
    }
    // Belt-and-suspenders: also strip 'agy' out of an EXPLICIT participants
    // list here, not just validateMode. validateMode is the primary,
    // user-facing rejection (setMode throws before the row is ever
    // persisted), but this filter is the dispatch-time backstop for any
    // row that predates that guard (or was written directly to the store,
    // bypassing setMode — see the N-way participants tests) — the shared-
    // token hazard this is defending is worth a second, cheap check.
    const filtered = list.filter(p => deps.registry.has(p) && p !== 'agy')
    if (filtered.length < list.length) {
      deps.log('COORDINATOR', `chat=${chatId} participants filtered ${list.join(',')} → ${filtered.join(',')} (registry: ${deps.registry.list().join(',')})`)
    }
    if (filtered.length > 3) {
      const capped = filtered.slice(0, 3)
      deps.log('COORDINATOR', `chat=${chatId} participants > 3; capping at ${capped.join(',')}`)
      return capped
    }
    return filtered
  }

  const authFailThrottleMs = deps.authFailNotifyThrottleMs ?? 60 * 60_000
  const nowMs = deps.now ?? Date.now
  // chatId → last-notice-at; used to throttle the auth_failed notice.
  const authFailLastNotifyAt = new Map<string, number>()

  /** On auth_failed: release the in-memory session (so the next dispatch
   *  starts a fresh subprocess that re-reads keychain — self-heal without
   *  waiting for an idle gap that a busy chat never reaches), then send
   *  one throttled neutral notice. On throttle the chat is silent — the
   *  user already saw the notice within the window. */
  async function handleAuthFailed(chatId: string, alias: string, providerId: ProviderId, summary: TurnSummary): Promise<void> {
    deps.log('AUTH_FAILED', `chat=${chatId} alias=${alias} provider=${providerId} message=${JSON.stringify((summary.error ?? '').slice(0, 200))}`, {
      event: 'auth_failed',
      chat_id: chatId,
      project_alias: alias,
      provider: providerId,
    })
    // Release is best-effort — if it throws we still want to send the user
    // notice. release() being absent from the manager dep (e.g. in test
    // fixtures that don't exercise the recycle path) is also tolerated.
    try {
      // Release the same session triple that dispatchSolo/Parallel/Chatroom
      // registered under (per-chat now since Task 10). A fresh dispatch in
      // this chat re-acquires from a clean subprocess that re-reads
      // keychain creds.
      // SessionManager.release revokes the session's auth token (every release
      // path, incl. internal eviction) — no separate invalidate call here.
      await deps.manager.release?.({ alias, providerId, chatId })
    } catch (err) {
      deps.log('AUTH_FAILED', `release ${alias}/${providerId} threw: ${err instanceof Error ? err.message : err}`)
    }
    const last = authFailLastNotifyAt.get(chatId) ?? 0
    if (nowMs() - last < authFailThrottleMs) return
    authFailLastNotifyAt.set(chatId, nowMs())
    await notice(chatId, authFailNotice(providerId, summary.errorCode))
  }

  /** On a per-turn watchdog timeout: the agent stream stalled silently.
   *  Release the (now-poisoned) session so the NEXT message in this chat
   *  re-acquires a fresh subprocess instead of throwing "previous dispatch
   *  still in flight" forever — same self-heal shape as [[handleAuthFailed]].
   *  Then tell the user to retry. Unlike auth_failed this is not throttled:
   *  a timeout is a one-off transient, and the user needs to know their
   *  message was dropped, not silently swallowed. */
  async function handleTurnTimeout(chatId: string, alias: string, providerId: ProviderId, summary: TurnSummary): Promise<void> {
    deps.log('TURN_TIMEOUT', `chat=${chatId} alias=${alias} provider=${providerId} ${summary.error ?? ''}`, {
      event: 'turn_timeout',
      chat_id: chatId,
      project_alias: alias,
      provider: providerId,
    })
    try {
      // SessionManager.release revokes the session's auth token (see above).
      await deps.manager.release?.({ alias, providerId, chatId })
    } catch (err) {
      deps.log('TURN_TIMEOUT', `release ${alias}/${providerId} threw: ${err instanceof Error ? err.message : err}`)
    }
    await notice(chatId, '想了半天没想出来,刚才那条掉了…再发我一次?')
  }
  // RFC 03 review #11 — per-chat AbortController for in-flight chatroom
  // loops. dispatchChatroom registers; coordinator.cancel() signals; /stop
  // in mode-commands triggers cancel before flipping mode.
  const inFlightAborters = new Map<string, AbortController>()
  // Post-cancel-review CRITICAL 1 — chatroom's own preempt-loop AbortController
  // above has no analogue for solo/parallel/primary_tool: those are single-shot
  // dispatches with no round-boundary loop to abort, but the SessionHandle they
  // acquire from SessionManager DOES support cancel() (forwards to the
  // provider's AgentSession.cancel — see session-manager.ts). Without this,
  // coordinator.cancel() (and therefore /stop) was a no-op for every mode
  // except chatroom, even though every provider now implements cancel().
  // chatId → the set of in-flight handles' cancel closures (a Set, not a
  // single slot, because dispatchParallel acquires N handles concurrently
  // for one chatId). Registered right after acquire, unregistered when the
  // turn settles — same lifecycle shape as inFlightAborters.
  const inFlightHandleCancels = new Map<string, Set<() => void>>()
  function registerHandleCancel(chatId: string, fn: () => void): () => void {
    let set = inFlightHandleCancels.get(chatId)
    if (!set) { set = new Set(); inFlightHandleCancels.set(chatId, set) }
    set.add(fn)
    return () => {
      set!.delete(fn)
      if (set!.size === 0) inFlightHandleCancels.delete(chatId)
    }
  }
  // PR C2 — per-chat promise that resolves when the active dispatchChatroom
  // call has finished its finally block (aborter slot cleared). A NEW
  // chatroom dispatch in the same chat awaits this so the "latest user msg
  // wins" preempt path doesn't race the prior loop's cleanup.
  const inFlightDispatchPromises = new Map<string, Promise<void>>()

  // Task 1 (session-serialization) — per-chatId async mutex. `dispatch`
  // (below) wraps `dispatchInner` in this for solo/parallel/primary_tool so
  // two rapid inbound messages for one chat never run concurrently. Chatroom
  // is exempt — see the comment on `dispatch`.
  const mutex = makeChatMutex()
  // 第二轮评审 #194 P2:**同一个底层会话同一时刻只有一个回合**。按 (chat, project, provider) —— 和
  // SessionManager 的会话键同一个粒度 —— 串行每一次发送:单模型队列(上面的 per-chat 锁)和 /chat
  // 抢占(不持 per-chat 锁)两条路在网络来回切换时会交接,两条路的回合都落到这把锁上,就不可能
  // 在同一个会话上撞车(acp_turn_already_running)。它是叶子锁:持有它的时候从不去拿 per-chat 锁。
  // 锁空着就**当场**开始(不多让出一拍):取消 / 抢占靠同步登记,不能因为这把锁晚一拍。
  const sessionTails = new Map<string, Promise<void>>()
  function oneTurnPerSession<T>(chatId: string, alias: string, providerId: ProviderId, fn: () => Promise<T>): Promise<T> {
    const key = `${chatId}\u0000${alias}\u0000${providerId}`
    const prev = sessionTails.get(key)
    let run: Promise<T>
    if (prev) run = prev.then(fn, fn)
    else { try { run = fn() } catch (err) { run = Promise.reject(err) } }
    const tail = run.then(() => undefined, () => undefined)
    sessionTails.set(key, tail)
    void tail.then(() => { if (sessionTails.get(key) === tail) sessionTails.delete(key) })
    return run
  }

  function validateMode(mode: Mode): void {
    // Reject unknown providers up front so the caller (mode-commands or
    // a programmatic setter) gets a clear error instead of a downstream
    // "unknown provider" from acquire().
    if (mode.kind === 'solo') {
      if (!deps.registry.has(mode.provider)) {
        throw new Error(`unknown provider: ${mode.provider} (registered: ${deps.registry.list().join(', ')})`)
      }
    }
    if (mode.kind === 'primary_tool') {
      if (!deps.registry.has(mode.primary)) {
        throw new Error(`unknown primary provider: ${mode.primary}`)
      }
      // B2(spec §4):持久化状态里翻出的旧非法组合也要拦 —— 与 registry
      // 未注册同姿势,抛错由 setMode 调用方转成用户可见的失败。
      if (!capabilitiesFor(mode.primary).supportsDelegation) {
        throw new Error(`provider '${mode.primary}' cannot delegate (supportsDelegation=false) — primary_tool mode unavailable`)
      }
      // The peer (other registered provider) must also be available so
      // delegate-mcp can actually do something. parallelProviders is
      // also the "all participating providers" set for primary_tool.
      const missing = parallelProviders.filter(p => !deps.registry.has(p))
      if (missing.length > 0) {
        throw new Error(`mode 'primary_tool' requires both providers ${parallelProviders.join(', ')}; missing: ${missing.join(', ')}`)
      }
    }
    if (mode.kind === 'parallel' || mode.kind === 'chatroom') {
      // Explicit participants must all be registered. Undefined defers
      // to dispatch-time resolution (resolveParticipants).
      if (mode.participants !== undefined) {
        // agy final-review CRITICAL 1: agy rides a tier-C shared 'trusted'
        // MCP token (spec §3) — spec §7 declares parallel/chatroom an
        // explicit non-goal. `/both claude agy` / `/chat codex agy` (or a
        // programmatic POST /v1/conversation/set-mode with the same shape)
        // would otherwise put a guest chat's turn on the same channel a
        // trusted chat's agy session uses. Reject structurally here — this
        // is the ONE validateMode chokepoint every caller (mode-commands
        // AND the HTTP route) goes through, so there's no second path that
        // can smuggle agy into a participants list.
        if (mode.participants.includes('agy')) {
          throw new Error(`provider 'agy' cannot join parallel/chatroom modes (shared-token channel; spec §7 non-goal)`)
        }
        const unknown = mode.participants.filter(p => !deps.registry.has(p))
        if (unknown.length > 0) {
          throw new Error(`mode '${mode.kind}' has unknown providers: ${unknown.join(', ')} (registered: ${deps.registry.list().join(', ')})`)
        }
        if (mode.participants.length < 2) {
          throw new Error(`mode '${mode.kind}' requires ≥2 participants; got ${mode.participants.length}`)
        }
      }
      // No else — undefined is fine; resolveParticipants handles fresh
      // and legacy chats.
    }
  }

  async function dispatchSolo(
    msg: InboundMsg,
    proj: { alias: string; path: string },
    providerId: ProviderId,
    // The mode this dispatch is serving, for the TurnRecord. dispatchSolo is
    // the single-provider dispatch path for solo AND primary_tool AND a
    // parallel/chatroom that degraded to one participant — recording a literal
    // 'solo' would mislabel those in GET /v1/turns and misdirect diagnosis.
    recordMode: TurnRecord['mode'] = 'solo',
  ): Promise<void> {
    // Dispatch-time fail-closed provider gate (core/provider-policy.ts).
    // mode-commands' slash gate only guards the SLASH flip: POST
    // /v1/conversation/set-mode can set any solo row directly, and a row set
    // validly while the chat WAS trusted survives a later demotion to guest in
    // access.json with no re-validation. Both land here — refuse to spawn
    // rather than trust the mode row's vintage. Raw resolveTier (NOT
    // resolveEffectiveTier) on purpose: --dangerously⇒admin must not unlock
    // a provider a guest may not use: agy (one long-lived 'trusted' token for
    // every conversation — agy-mcp-config.ts) or cursor (ACP: its own file
    // edits inside the workspace never surface a permission card, so a guest's
    // tier cannot confine it — ProviderCapabilities.guestSafe === false).
    // Originally agy-only ("agy final-review Important 2").
    {
      const rawTier = resolveTier(msg.chatId, deps.loadAccess())
      const denial = providerDenialFor(providerId, rawTier, deps.trustedProviders?.())
      if (denial) {
        deps.log('COORDINATOR', `chat=${msg.chatId} refuse solo+${providerId} dispatch: ${denial.kind} tier=${rawTier} (dispatch-time gate)`, {
          event: denial.kind === 'shared_token_guest' ? 'shared_token_guest_refused' : denial.kind === 'unconfined_guest' ? 'unconfined_guest_refused' : 'provider_not_allowed_refused',
          chat_id: msg.chatId,
          provider: providerId,
        })
        await notice(msg.chatId, describeProviderDenial(denial, slashFor(providerId)))
        return
      }
    }
    if (deps.networkGate && (await admitProviders(msg, [providerId])).length === 0) return
    const tier = resolveEffectiveTier(msg.chatId, deps.loadAccess(), deps.permissionMode)
    const tierProfile = TIER_PROFILES[tier]
    deps.log('COORDINATOR', `solo chat=${msg.chatId} → project=${proj.alias} provider=${providerId} tier=${tier}`, {
      event: 'dispatch_solo',
      chat_id: msg.chatId,
      project_alias: proj.alias,
      provider: providerId,
      tier,
    })
    // One structured TurnRecord is emitted per dispatch in the finally
    // below — exactly once, on every path (completed / timeout / auth /
    // unexpected throw). This is the AI-legible / human-legible trace that
    // makes "why did chat X stop replying at HH:MM" a query, not a log dig.
    const startedAt = nowMs()
    let outcome: TurnRecord['outcome'] = 'error'
    let summary: TurnSummary | undefined
    let unregisterCancel: (() => void) | undefined
    // 回复交付 shadow(spec §5.1 第 3 项):照旧走 legacy,另外把「按新路会发什么」与 legacy 实际
    // 发出去的比一比,只记日志。从 dispatch 开始前就开着,reply 路由 / fallback 发出的每一条才旁听得到。
    let shadow: TurnDeliveryHandle | undefined
    // 回复交付 daemon(spec §4.3):最后的话经端口送达;report 落进 TurnRecord。
    let delivery: TurnDeliveryHandle | undefined
    let report: DeliveryReport | undefined
    let deliverySettled = false
    let progressTimer: ReturnType<typeof setTimeout> | undefined
    try {
      // Per-chat model pin lives on the solo mode row; only solo carries it.
      const cur = getMode(msg.chatId)
      const pinnedModel = cur.kind === 'solo' && cur.provider === providerId ? cur.model : undefined
      // 冷启动判定要在 acquire 之前看:acquire 之后缓存里一定有了。
      const coldSpawn = deps.manager.has ? !deps.manager.has({ alias: proj.alias, providerId, chatId: msg.chatId }) : false
      let handle: Awaited<ReturnType<typeof deps.manager.acquire>>
      try {
        handle = await deps.manager.acquire({
          alias: proj.alias,
          path: proj.path,
          providerId,
          chatId: msg.chatId,
          tierProfile,
          permissionMode: deps.permissionMode,
          ...(pinnedModel !== undefined ? { model: pinnedModel } : {}),
        })
      } catch (err) {
        // spawn 阶段就挂了(二进制不在 / 首次使用探测没过 / SDK 起不来):
        // 之前这个异常一路冒到 dispatch 外层只记日志,用户端一片沉默。
        // 沉默 = 被无视;把原因用人话交给用户,并记一条 turn。
        const detail = err instanceof Error ? err.message : String(err)
        // 边界在抛出物上挂了码(比如 Cursor ACP 建会话时的 -32000 未登录)就按码走:
        // 认证 ⇒ 与回合里的认证失败同一条路(释放 + 节流提示,措辞按码分);其余 ⇒ 老实的原因。
        const code = providerErrorCodeOf(err)
        summary = { assistantText: [], replyToolCalled: false, toolCalls: [], error: detail, ...(code ? { errorCode: code } : {}) }
        deps.log('COORDINATOR', `chat=${msg.chatId} provider=${providerId} spawn failed${code ? ` code=${code}` : ''}: ${detail.slice(0, 300)}`, { event: 'spawn_failed', chat_id: msg.chatId, provider: providerId })
        if (isAuthErrorCode(code)) {
          outcome = 'auth_failed'
          await handleAuthFailed(msg.chatId, proj.alias, providerId, summary)
          return
        }
        outcome = 'error'
        await notice(msg.chatId, spawnFailedNotice(providerId, detail, code))
        return
      }
      // Registered before collectTurn starts draining so /stop can reach
      // this turn for its entire lifetime — cleared in the finally below,
      // same lifecycle as chatroom's inFlightAborters.
      unregisterCancel = registerHandleCancel(msg.chatId, () => { void handle.cancel?.() })
      let text = deps.format(msg)
      // 换 provider 后的第一条:前置交接块(近况原文 + chat_history 提示)。
      const handoff = handoffLedger.takeHandoff(msg.chatId)
      if (handoff) {
        let recent: HandoffTurn[] = []
        try { recent = await deps.recentTurns?.(msg.chatId, 12) ?? [] } catch { /* 交接是增强,拿不到就只给提示语 */ }
        text = `${buildHandoffBlock(handoff.from, handoff.to, recent)}\n\n${text}`
        deps.log?.('HANDOFF', `chat=${msg.chatId} ${handoff.from}→${handoff.to} recent=${recent.length}`)
      } else if (coldSpawn && !capabilitiesFor(providerId).supportsResume) {
        // 不能续线程的 provider(openai/gemini)刚被冷 spawn:daemon 重启 /
        // 空闲驱逐后它对「刚才聊到哪」一无所知,而 claude/agy 都接得上。
        // 用交接块同样的原文源补一段近况;新对话(没记录)就什么都不加。
        let recent: HandoffTurn[] = []
        try { recent = await deps.recentTurns?.(msg.chatId, 12) ?? [] } catch { /* 增强,拿不到就算了 */ }
        if (recent.length > 0) {
          text = `${buildColdStartBlock(providerId, recent)}\n\n${text}`
          deps.log?.('HANDOFF', `chat=${msg.chatId} cold-start ${providerId} recent=${recent.length}`)
        }
      }
      const deliveryMode = deliveryModeFor(providerId)
      if (deliveryMode === 'shadow') {
        try { shadow = deps.replyDelivery!.begin(msg.chatId, { mode: 'shadow', context: 'dm', providerId, textStrategy: textStrategyFor(providerId) }) } catch { shadow = undefined }
      }
      // daemon:开轮(附件从此刻起登记到这一轮)。编码型执行者(last_segment)挂上长任务进度(已定 ①:
      // 一轮最多一次,有旁白用最近一段);聊天型模型(all_segments)每段都会交付,不发进度。
      const textStrategy = textStrategyFor(providerId)
      const live = deliveryMode === 'daemon' ? makeTurnTextCollector() : undefined
      if (deliveryMode === 'daemon') {
        delivery = deps.replyDelivery!.begin(msg.chatId, { mode: 'daemon', context: 'dm', providerId, textStrategy })
      }
      if (delivery && textStrategy === 'last_segment') {
        const d = delivery
        progressTimer = setTimeout(() => {
          progressTimer = undefined
          void d.progress(live!.latestSegment() ?? LONG_TURN_PROGRESS).catch(() => {})
        }, deps.replyProgressAfterMs ?? LONG_TURN_PROGRESS_MS)
      }
      summary = await oneTurnPerSession(msg.chatId, proj.alias, providerId, () => collectTurn(handle.dispatch(text), { timeoutMs: deps.turnTimeoutMs, onEvent: (ev) => { live?.push(ev); deps.onTurnEvent?.(msg.chatId, ev) } }))
      if (progressTimer) { clearTimeout(progressTimer); progressTimer = undefined }
      const assistantTexts = summary.assistantText
      const replyToolCalled = summary.replyToolCalled
      const settle = (reason: string) => { if (delivery && !deliverySettled) { deliverySettled = true; delivery.abandon(reason) } }

      // Per-turn watchdog fired: the SDK stream went silent. Discard the
      // wedged session and tell the user to retry — must come before the
      // fallback-text path so a stalled turn never leaks a partial reply.
      if (summary.errorCode === TURN_TIMEOUT_CODE) {
        outcome = 'timeout'
        settle('timeout')
        await handleTurnTimeout(msg.chatId, proj.alias, providerId, summary)
        return
      }

      // Structured auth-failure path: provider intercepted the "Not logged in"
      // assistant text and re-emitted it as a coded error. Suppress fallback
      // and send a throttled neutral notice instead — never leak provider
      // failure text to the user.
      if (isAuthErrorCode(summary.errorCode)) {
        outcome = 'auth_failed'
        settle('auth_failed')
        await handleAuthFailed(msg.chatId, proj.alias, providerId, summary)
        return
      }

      outcome = summary.error ? 'error' : 'completed'

      // 回复交付 daemon(spec §4.2 末段 / §4.3):只有 completed 的轮交付最后的话;出错一律只发通知、
      // 不发残文(与 #190「错误不许当回复发」同一条红线)。没有 FALLBACK_REPLY:有文字没调工具是正常路径。
      if (delivery) {
        if (outcome !== 'completed') {
          settle('error')
          await notice(msg.chatId, turnErrorNotice(providerId, summary.error, summary.errorCode))
          return
        }
        deliverySettled = true
        // 核对(回复交付第 5 步):provider 自己也报了「最后的话」(Claude 的 result.result)⇒ 和分段的结果比一下。
        // 交付永远用分段的结果;对不上只记一行,留给真机看分段规则有没有漏(子 agent 文字、块顺序……)。
        if (summary.providerFinalText !== undefined && summary.providerFinalText.trim() !== (summary.finalText ?? '').trim()) {
          deps.log('REPLY_FINAL_CHECK', `chat=${msg.chatId} provider=${providerId} match=differs segments_len=${(summary.finalText ?? '').length} sdk_len=${summary.providerFinalText.length}`)
        }
        report = await delivery.deliver({ finalText: summary.finalText ?? '', narration: summary.narration ?? [] })
        noteDelivery(providerId, report.delivery)
        return
      }

      // Generic-error silence guard (2026-08-25): a turn that died with an
      // error, called no reply tool and produced no assistant text used to
      // leave the user staring at nothing — silence reads as being ignored.
      // Tell them, in CC's voice, that the message was dropped and where the
      // fix lives. Unthrottled on purpose (same rationale as the timeout
      // notice: each dropped message deserves an acknowledgement).
      if (summary.error && !replyToolCalled && assistantTexts.length === 0) {
        await notice(msg.chatId, turnErrorNotice(providerId, summary.error, summary.errorCode))
        return
      }

      // Same fallback semantics as the legacy routeInbound: only forward
      // raw assistant text when the agent did NOT call a reply-family
      // tool this turn. Prevents the duplicate-message footgun while
      // protecting users from a forgetful agent that describes an image
      // in plain text without ever calling reply.
      if (replyToolCalled) {
        if ((fallbackStreak.get(providerId) ?? 0) > 0) { fallbackStreak.set(providerId, 0); deps.onFallbackStreak?.(providerId, 0) }
        return
      }
      if (assistantTexts.length === 0) return
      {
        const n = (fallbackStreak.get(providerId) ?? 0) + 1
        fallbackStreak.set(providerId, n)
        deps.onFallbackStreak?.(providerId, n)
      }
      deps.log('FALLBACK_REPLY', `chat=${msg.chatId} project=${proj.alias} provider=${providerId} chunks=${assistantTexts.length} preview=${JSON.stringify(assistantTexts[0]?.slice(0, 80) ?? '')}`)
      for (const t of assistantTexts) {
        await deps.sendAssistantText?.(msg.chatId, t)
      }
    } finally {
      unregisterCancel?.()
      if (progressTimer) clearTimeout(progressTimer)
      if (delivery && !deliverySettled) { deliverySettled = true; try { delivery.abandon(outcome) } catch { /* 记账不影响回合 */ } }
      // shadow 只是记账:绝不能影响这一轮(抛错就地吞掉)。只有 completed 的轮才比 —— 新路也只交付那些。
      if (shadow) {
        try {
          if (outcome === 'completed' && summary) await shadow.deliver({ finalText: summary.finalText ?? '', narration: summary.narration ?? [] })
          else shadow.abandon(outcome)
        } catch (err) {
          deps.log('REPLY_SHADOW', `chat=${msg.chatId} provider=${providerId} shadow threw: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      const endedAt = nowMs()
      deps.recordTurn?.({
        chatId: msg.chatId,
        provider: providerId,
        alias: proj.alias,
        mode: recordMode,
        startedAt,
        endedAt,
        durationMs: endedAt - startedAt,
        outcome,
        replyToolCalled: summary?.replyToolCalled ?? false,
        toolCalls: summary?.toolCalls ?? [],
        textChunks: summary?.assistantText.length ?? 0,
        error: summary?.error,
        errorCode: summary?.errorCode,
        ...deliveryColumns(report, summary),
      })
    }
  }

  /**
   * RFC 03 §4.4 chatroom mode (conductor pipeline — three beats).
   *
   * Beat ①: parallel opening — all participants answer the raw question.
   * Beat ②: parallel cross-talk — each engages the others' openings
   *          (optional extra round if still materially split after the first).
   * Beat ③: verdict — a judged haiku synthesis prefixed with 🎯.
   *
   * The old per-round LLM moderator (evaluateRound) was retired; routing
   * is now structural rather than LLM-decided per round.
   */
  async function dispatchChatroom(
    msg: InboundMsg,
    proj: { alias: string; path: string },
    participants: ProviderId[],
  ): Promise<void> {
    // P3 — N participants. Coordinator's resolveParticipants enforces ≥2
    // and ≤3. Empty/single is degraded to solo upstream.

    // PR C2 — preempt any in-flight dispatch for this same chat. Without
    // this, two rapid messages produce concurrent loops that race on
    // chatroomHistories.set (last writer wins → lost user msgs).
    //
    // Loop is required for ≥3 rapid dispatches: when B and C both arrive
    // while A is in flight, both read A as their prior and both await A.
    // After A finishes, both wake; if only the FIRST checks-and-claims
    // the slot, the SECOND would silently overwrite without aborting. We
    // re-read after each await so each new wave gets preempted by the
    // next arrival, all the way until the slot is empty (in single-
    // threaded-JS sense — guaranteed by the synchronous map set below).
    while (true) {
      const priorAborter = inFlightAborters.get(msg.chatId)
      const priorPromise = inFlightDispatchPromises.get(msg.chatId)
      if (!priorAborter) break
      deps.log('COORDINATOR_CHATROOM', `chat=${msg.chatId} → preempting prior in-flight dispatch`)
      priorAborter.abort()
      if (priorPromise) {
        try { await priorPromise } catch { /* prior dispatch's own error path */ }
      }
    }

    // RFC 03 review #11 — per-chat AbortController so /stop can preempt
    // an in-flight loop. Single-flight per chat (see preempt step above).
    const aborter = new AbortController()
    inFlightAborters.set(msg.chatId, aborter)

    let dispatchResolve!: () => void
    const dispatchPromise = new Promise<void>(resolve => { dispatchResolve = resolve })
    inFlightDispatchPromises.set(msg.chatId, dispatchPromise)

    // Tier is derived once at dispatch entry — both speaker turns within
    // the same /chat originate from the same chatId so they share the
    // same tier profile. (Re-resolving per round would let an access.json
    // edit mid-loop take effect; we prefer consistency within one user
    // turn.)
    const tier = resolveEffectiveTier(msg.chatId, deps.loadAccess(), deps.permissionMode)
    const tierProfile = TIER_PROFILES[tier]

    try {
      // ── Beat ①: parallel opening — every panel agent answers the raw question.
      //
      // Re-inject [chat_id:xxx] ahead of the formatted envelope. Solo /
      // parallel dispatch deps.format(msg) verbatim, so the speaker sees the
      // <wechat chat_id="..."> envelope directly and can namespace
      // memory_*/set_user_name under it. Chatroom instead embeds
      // deps.format(msg) as `question` inside the conductor's prompt
      // builders (buildOpeningPrompt/buildRebuttalPrompt) — the envelope's
      // chat_id="..." attribute is present there too, but only as XML, not
      // the bracket form the speaker's tool-routing convention expects.
      // This was fixed once for the old LLM moderator (b69973f) which
      // paraphrased the envelope away entirely; deleting the moderator
      // (a4101ca) dropped the injection along with it even though the
      // bracket form was never restored. Prepending it here covers every
      // beat that embeds `question` (opening, rebuttal, convergence, verdict).
      const question = `[chat_id:${msg.chatId}]\n${deps.format(msg)}`

      const openings = await runBeat(msg, proj, tierProfile, participants, (p) => buildOpeningPrompt(question, participants, p))
      if (openings.length === 0) {
        await notice(msg.chatId, '⚠️ 这轮没有 AI 成功回应，请稍后重发一次。')
        return
      }

      if (aborter.signal.aborted) { deps.log('COORDINATOR_CHATROOM', `chat=${msg.chatId} aborted mid-debate`); return }

      // 从这里往下**全程匿名**。互驳与裁决的 prompt 里不再出现 provider 名字
      // (抄 karpathy/llm-council 的 Stage 2)——模型对着名牌客气、对着陌生
      // 名字挑刺,这是白送的偏见。用户那边照旧看到 [claude]/[codex] 前缀。
      const labels = labelOpenings(openings)

      // ── Beat ①b:争点地图。先花一次 cheapEval 问「他们到底在争什么」。
      // 抽不出争点 ⇒ **整个互驳拍跳过**,直接收口:三个模型说的是同一件事时
      // 再逼他们互驳,只会产出客套话和虚假对立(而且贵三倍)。
      let contention: Contention = { contested: [], agreed: [] }
      if (deps.haikuEval && openings.length >= 2) {
        try { contention = parseContention(await deps.haikuEval(buildContentionPrompt(question, labels))) }
        catch (e) { deps.log('COORDINATOR_CHATROOM', `contention map failed: ${e instanceof Error ? e.message : e}`) }
      }

      // 没有 cheapEval 时不能把「问不出争点」误当成「没有争点」—— 那会让
      // 整个辩论悄悄退化成一拍。没有它就退回旧行为:照常互驳,只是没有靶子。
      const shouldRebut = openings.length >= 2 && (!deps.haikuEval || contention.contested.length > 0)
      if (openings.length >= 2 && !shouldRebut) {
        deps.log('COORDINATOR_CHATROOM', `chat=${msg.chatId} 开场无实质分歧 —— 跳过互驳,直接裁决`)
      }

      // 跳过互驳是**正确**行为,但它长得跟「互驳这个功能坏了」一模一样 ——
      // 用户只会看到少了两条发言。说一句,免得省下来的这一刀被当成 bug。
      const notes: string[] = []
      if (openings.length >= 2 && !shouldRebut) notes.push('（开场没有实质分歧，跳过了互驳这一轮）')

      let rebuttals: Opening[] = []
      let ranking: RankedSpeaker[] = []
      if (shouldRebut) {
        // ── Beat ②:匿名 + 只打争点 + 每人一个指派视角 + 顺带交一张互评票。
        const speakers = openings.map(o => o.speaker)
        const beat2 = await runBeat(msg, proj, tierProfile, speakers,
          (p) => buildRebuttalPrompt(question, {
            labels, contested: contention.contested, lens: lensFor(speakers.indexOf(p)), self: p,
          }), true)
        rebuttals = beat2.map(b => ({ speaker: b.speaker, text: b.text }))
        const votes = beat2.map(b => ({ voter: b.speaker, ranking: b.ranking }))

        if (aborter.signal.aborted) { deps.log('COORDINATOR_CHATROOM', `chat=${msg.chatId} aborted mid-debate`); return }

        // ── Beat ②b (optional, capped at 1): only if still materially split.
        if (deps.haikuEval && rebuttals.length >= 2) {
          let conv = { converged: true } as { converged: boolean; disagreement?: string }
          try { conv = parseConvergence(await deps.haikuEval(buildConvergencePrompt(question, labels, rebuttals))) }
          catch { /* parseConvergence never throws; haikuEval might — treat as converged */ }
          if (!conv.converged && conv.disagreement) {
            const extra = await runBeat(msg, proj, tierProfile, speakers,
              (p) => buildRebuttalPrompt(question, {
                labels, contested: contention.contested, lens: lensFor(speakers.indexOf(p)), self: p,
                focus: conv.disagreement!,
              }), true)
            rebuttals = [...rebuttals, ...extra.map(b => ({ speaker: b.speaker, text: b.text }))]
            votes.push(...extra.map(b => ({ voter: b.speaker, ranking: b.ranking })))
          }
        }
        ranking = aggregateRanking(votes, labels)
        if (ranking.length) {
          deps.log('COORDINATOR_CHATROOM', `chat=${msg.chatId} 互评(他评,不含自投):${ranking.map(r => `${r.speaker}=${r.score}`).join(' ')}`)
        }
      }

      if (aborter.signal.aborted) { deps.log('COORDINATOR_CHATROOM', `chat=${msg.chatId} aborted mid-debate`); return }

      // ── Beat ③: verdict — a judged synthesis on the STRONG model (default
      // provider), falling back to the cheap eval. Plain text (no parse). Always emitted.
      const verdictEval = deps.verdictEval ?? deps.haikuEval
      if (verdictEval) {
        let verdict = ''
        try {
          verdict = (await verdictEval(buildVerdictPrompt(question, {
            labels, rebuttals, contested: contention.contested, ranking,
          }))).trim()
        }
        catch (e) { deps.log('COORDINATOR_CHATROOM', `verdict failed: ${e instanceof Error ? e.message : e}`) }
        if (verdict) {
          // 名次跟裁决同一条消息发出去 —— 微信上多一条消息就是多一次打扰,
          // 而这一行恰恰是让「这场辩论有没有用」变得可衡量的东西。
          const footer = [formatRankingFooter(ranking), ...notes].filter(Boolean).join('\n')
          const body = verdict.startsWith('🎯') ? verdict : `🎯 ${verdict}`
          await deps.sendAssistantText?.(msg.chatId, footer ? `${body}\n\n${footer}` : body)
        }
      }
    } finally {
      if (inFlightAborters.get(msg.chatId) === aborter) {
        inFlightAborters.delete(msg.chatId)
      }
      if (inFlightDispatchPromises.get(msg.chatId) === dispatchPromise) {
        inFlightDispatchPromises.delete(msg.chatId)
      }
      dispatchResolve()
    }
  }

  /**
   * RFC 03 §4.3 parallel mode: fan out the same inbound to every
   * registered parallel provider concurrently. Both handles dispatch
   * independently; if one throws the other's reply still goes through
   * (Promise.allSettled). When a provider DID call its reply tool the
   * prefix is added at the internal-api layer (using participant_tag).
   * When a provider DIDN'T call reply but emitted assistant text, the
   * fallback path here adds the prefix in front of each chunk.
   */
  async function dispatchParallel(
    msg: InboundMsg,
    proj: { alias: string; path: string },
    participants: ProviderId[],
  ): Promise<void> {
    const tier = resolveEffectiveTier(msg.chatId, deps.loadAccess(), deps.permissionMode)
    const tierProfile = TIER_PROFILES[tier]
    deps.log('COORDINATOR', `parallel chat=${msg.chatId} → project=${proj.alias} providers=${participants.join(',')} tier=${tier}`)
    // allSettled the ACQUIRE phase too (not just dispatch): a single provider's
    // acquire rejection (spawn failure / pool exhausted) must NOT drop the other
    // provider's reply. A failed acquire is propagated into the same per-
    // participant settled shape below (as a rejected turn → recorded as an error
    // TurnRecord), keeping index alignment with `participants`.
    const acquired = await Promise.allSettled(
      participants.map(p => deps.manager.acquire({
        alias: proj.alias,
        path: proj.path,
        providerId: p,
        chatId: msg.chatId,
        tierProfile,
        permissionMode: deps.permissionMode,
      })),
    )
    const text = deps.format(msg)
    const startedAt = nowMs()
    // 回复交付 daemon:这家参与者的最后的话经端口送达(前缀 [名字] 由 daemon 加);开轮在 dispatch 之前,
    // 附件才登记得上。legacy 的参与者照旧每段一条。
    const deliveries = acquired.map((a, i) => {
      if (a.status !== 'fulfilled' || deliveryModeFor(participants[i]!) !== 'daemon') return undefined
      const dn = deps.registry.get(participants[i]!)?.opts.displayName ?? participants[i]!
      return deps.replyDelivery!.begin(msg.chatId, { mode: 'daemon', context: 'parallel', providerId: participants[i]!, participantLabel: dn, textStrategy: textStrategyFor(participants[i]!) })
    })
    // Register every acquired handle's cancel BEFORE dispatching — /stop must
    // reach whichever participants are in flight, not just the first. Each
    // handle gets its own slot in the shared per-chat set (dispatchSolo's
    // single-slot registration doesn't fit here: N participants share one
    // chatId).
    const unregisterCancels = acquired.map(a =>
      a.status === 'fulfilled' ? registerHandleCancel(msg.chatId, () => { void a.value.cancel?.() }) : undefined,
    )
    let settled: PromiseSettledResult<TurnSummary>[]
    try {
      settled = await Promise.allSettled(acquired.map(a =>
        a.status === 'fulfilled'
          ? oneTurnPerSession(msg.chatId, proj.alias, a.value.providerId, () => collectTurn(a.value.dispatch(text), { timeoutMs: deps.turnTimeoutMs, onEvent: (ev) => deps.onTurnEvent?.(msg.chatId, ev) }))
          : Promise.reject(a.reason),
      ))
    } finally {
      for (const u of unregisterCancels) u?.()
    }
    // Batch end — all participants dispatched together and allSettled awaits
    // them all, so a single endedAt is the honest wall-clock for the round.
    const endedAt = nowMs()

    const answers: Opening[] = []
    for (let i = 0; i < settled.length; i++) {
      const r = settled[i]!
      const providerId = participants[i]!

      // Exactly one TurnRecord per participant, emitted in the finally below — every branch
      // `continue`s, the finally still records. Recorded AFTER delivery so a daemon participant's
      // record carries the delivery columns like a solo turn (spec §4.10).
      const recSummary = r.status === 'fulfilled' ? r.value : undefined
      const recOutcome: TurnRecord['outcome'] =
        r.status === 'rejected' ? 'error'
        : r.value.errorCode === TURN_TIMEOUT_CODE ? 'timeout'
        : isAuthErrorCode(r.value.errorCode) ? 'auth_failed'
        : r.value.error ? 'error'
        : 'completed'
      let report: DeliveryReport | undefined
      try {
        const turnDelivery = deliveries[i]
        if (turnDelivery && (r.status === 'rejected' || r.value.error)) turnDelivery.abandon(r.status === 'rejected' ? 'threw' : (r.value.errorCode ?? 'error'))
        if (r.status === 'rejected') {
          deps.log('COORDINATOR_PARALLEL', `provider=${providerId} threw: ${r.reason instanceof Error ? r.reason.message : r.reason}`)
          continue
        }
        // Watchdog fired for this participant — release its wedged session and
        // notify; the other provider's reply (handled below) still goes out.
        if (r.value.errorCode === TURN_TIMEOUT_CODE) {
          await handleTurnTimeout(msg.chatId, proj.alias, providerId, r.value)
          continue
        }
        // Same self-heal as solo: the failing provider's session is released
        // so the next /both dispatch spawns a fresh subprocess. handleAuthFailed
        // also fires (one throttled neutral notice across both providers per
        // chat per hour). The other provider's reply (if any) still goes
        // through below — partial reply is better than no reply.
        if (isAuthErrorCode(r.value.errorCode)) {
          await handleAuthFailed(msg.chatId, proj.alias, providerId, r.value)
          continue
        }
        if (turnDelivery) {
          if (r.value.error) continue
          const parts = { finalText: r.value.finalText ?? '', narration: r.value.narration ?? [] }
          report = await turnDelivery.deliver(parts)
          // 综合用的答案和交付出去的是同一份文字(同一个策略、同样剥掉令牌)。
          const said = buildTurnReply(parts, [], 'parallel', textStrategyFor(providerId)).reply
          if (!said.silent && said.text.trim()) answers.push({ speaker: providerId, text: said.text.trim() })
          continue
        }
        const { assistantText, replyToolCalled } = r.value
        if (replyToolCalled || assistantText.length === 0) continue
        // Provider didn't call reply tool — fall back to forwarding raw
        // assistant text, prefixed so the user can tell who said what.
        const dn = deps.registry.get(providerId)?.opts.displayName ?? providerId
        deps.log('FALLBACK_REPLY', `chat=${msg.chatId} provider=${providerId} chunks=${assistantText.length} (parallel)`)
        for (const t of assistantText) {
          await deps.sendAssistantText?.(msg.chatId, `[${dn}] ${t}`)
        }
        const joined = assistantText.join('\n').trim()
        if (joined) answers.push({ speaker: providerId, text: joined })
      } finally {
        deps.recordTurn?.({
          chatId: msg.chatId,
          provider: providerId,
          alias: proj.alias,
          mode: 'parallel',
          startedAt,
          endedAt,
          durationMs: endedAt - startedAt,
          outcome: recOutcome,
          replyToolCalled: recSummary?.replyToolCalled ?? false,
          toolCalls: recSummary?.toolCalls ?? [],
          textChunks: recSummary?.assistantText.length ?? 0,
          error: recSummary?.error ?? (r.status === 'rejected' ? (r.reason instanceof Error ? r.reason.message : String(r.reason)) : undefined),
          errorCode: recSummary?.errorCode,
          ...deliveryColumns(report, recSummary),
        })
      }
    }

    // ── /both 的收口。原本是「N 条答案并排丢给用户」,合并的活全推给人 ——
    // 在微信这块屏幕上尤其糟。并排保留(对比本身有价值),末尾补一条可以
    // 直接用的答案。不做互驳:那是 /chat 的事,/both 要的就是便宜和快。
    //
    // 少于两条就没什么可合的(一条答案的"综合"只是复读);拿不到文本的
    // 参与者(reply 工具被 permission-relay 拦掉之后已是罕见路径)不参与。
    const synthEval = deps.verdictEval ?? deps.haikuEval
    if (answers.length >= 2 && synthEval) {
      try {
        const synth = (await synthEval(buildParallelSynthesisPrompt(text, labelOpenings(answers)))).trim()
        if (synth) await deps.sendAssistantText?.(msg.chatId, synth.startsWith('🎯') ? synth : `🎯 ${synth}`)
      } catch (e) {
        deps.log('COORDINATOR_PARALLEL', `synthesis failed: ${e instanceof Error ? e.message : e}`)
      }
    } else if (answers.length >= 2) {
      deps.log('COORDINATOR_PARALLEL', `chat=${msg.chatId} 没有可用的 eval —— 跳过收口,只并排`)
    }
  }

  /** 一位参与者在一拍里的产出。`ranking` 只有互驳拍才非空(见 parsePeerRank)。 */
  interface BeatResult extends Opening { ranking: string[] }

  // One debate beat: run `participants` concurrently, each with its own prompt.
  // Emit each agent's text the moment that agent finishes (live feel, not
  // wait-for-slowest), record one chatroom TurnRecord per agent, and return the
  // {speaker,text} of agents that produced non-empty output (others dropped —
  // graceful degradation). Shares the fan-out shape with dispatchParallel.
  async function runBeat(
    msg: InboundMsg,
    proj: { alias: string; path: string },
    tierProfile: TierProfile,
    participants: ProviderId[],
    promptFor: (p: ProviderId) => string,
    /** 互驳拍为 true:把 `#RANK:` 行当作这一位投出的选票计入互评。
     *  **剥离**那一行则是无条件的** —— 它是内部信号,任何一拍里冒出来都
     *  不该出现在给用户看的发言里(开场并没有要求它,但模型偶尔会自作主张)。 */
    countRank = false,
  ): Promise<BeatResult[]> {
    const results = await Promise.all(participants.map(async (providerId): Promise<BeatResult | null> => {
      const startedAt = nowMs()
      let summary: Awaited<ReturnType<typeof collectTurn>> | undefined
      let err: string | undefined
      const dn = deps.registry.get(providerId)?.opts.displayName ?? providerId
      // 回复交付 daemon(spec §4.9):这位发言人的最后的话经端口送达(前缀 [名字] 由 daemon 加,/chat 一人一条
      // 不分条);开轮在 dispatch 之前,附件才登记得上。legacy 的发言人照旧拼全部文字一条发。
      let delivery: TurnDeliveryHandle | undefined
      let report: DeliveryReport | undefined
      try {
        const handle = await deps.manager.acquire({
          alias: proj.alias, path: proj.path, providerId,
          chatId: msg.chatId, tierProfile, permissionMode: deps.permissionMode,
        })
        if (deliveryModeFor(providerId) === 'daemon') {
          delivery = deps.replyDelivery!.begin(msg.chatId, { mode: 'daemon', context: 'chatroom', providerId, participantLabel: dn, textStrategy: textStrategyFor(providerId) })
        }
        summary = await oneTurnPerSession(msg.chatId, proj.alias, providerId, () => collectTurn(handle.dispatch(promptFor(providerId)), { timeoutMs: Math.min(deps.turnTimeoutMs ?? CHATROOM_BEAT_TIMEOUT_MS, CHATROOM_BEAT_TIMEOUT_MS), onEvent: (ev) => deps.onTurnEvent?.(msg.chatId, ev) }))
      } catch (e) {
        err = e instanceof Error ? e.message : String(e)
      }
      const endedAt = nowMs()
      const outcome: TurnRecord['outcome'] =
        err ? 'error'
        : summary?.errorCode === TURN_TIMEOUT_CODE ? 'timeout'
        : isAuthErrorCode(summary?.errorCode) ? 'auth_failed'
        : summary?.error ? 'error'
        : 'completed'
      try {
        if (delivery && outcome !== 'completed') delivery.abandon(outcome)
        // Self-heal parity with dispatchParallel: release wedged/stale sessions
        // and notify the user, per-provider, so beats continue for healthy agents.
        if (outcome === 'timeout' && summary) {
          await handleTurnTimeout(msg.chatId, proj.alias, providerId, summary)
          return null
        }
        if (outcome === 'auth_failed' && summary) {
          await handleAuthFailed(msg.chatId, proj.alias, providerId, summary)
          return null
        }
        if (delivery) {
          if (outcome !== 'completed' || !summary) return null
          // `#RANK:` 是内部信号:先在 conductor 这一侧剥掉(§4.9),交付与互评用同一份剥过的文字。
          const ranks: string[][] = []
          const strip = (t: string): string => { const p = parsePeerRank(t); if (p.ranking.length) ranks.push(p.ranking); return p.text }
          const parts = { finalText: strip(summary.finalText ?? ''), narration: (summary.narration ?? []).map(strip) }
          report = await delivery.deliver(parts)
          const said = buildTurnReply(parts, [], 'chatroom', textStrategyFor(providerId)).reply
          const text = said.silent ? '' : said.text.trim()
          if (!text) return null
          return { speaker: providerId, text, ranking: countRank ? (ranks[ranks.length - 1] ?? []) : [] }
        }
        // Defense-in-depth: canUseTool already denies the reply tool in
        // chatroom mode, but if an agent still gets one through, its plain
        // `assistantText` is meta-chatter ("（本轮结束）"), not its real
        // argument — forwarding it leaks garbage AND poisons the verdict
        // transcript. Drop the turn instead. (Mirrors dispatchParallel.)
        if (summary?.replyToolCalled) {
          deps.log('COORDINATOR_CHATROOM', `chat=${msg.chatId} provider=${providerId} used reply tool in a beat — dropped`)
          return null
        }
        const raw = (summary?.assistantText ?? []).join('\n').trim()
        if (!raw) return null
        const parsed = parsePeerRank(raw)
        const text = parsed.text
        const ranking = countRank ? parsed.ranking : []
        if (!text) return null
        await deps.sendAssistantText?.(msg.chatId, `[${dn}] ${text}`)
        return { speaker: providerId, text, ranking }
      } finally {
        deps.recordTurn?.({
          chatId: msg.chatId, provider: providerId, alias: proj.alias, mode: 'chatroom',
          startedAt, endedAt, durationMs: endedAt - startedAt, outcome,
          replyToolCalled: summary?.replyToolCalled ?? false,
          toolCalls: summary?.toolCalls ?? [],
          textChunks: summary?.assistantText.length ?? 0,
          error: summary?.error ?? err,
          errorCode: summary?.errorCode,
          ...deliveryColumns(report, summary),
        })
      }
    }))
    return results.filter((r): r is BeatResult => r !== null)
  }

  /**
   * The pre-lock dispatch body (Task 1 — session-serialization). Renamed
   * from the original unserialized `dispatch`; behaviour is byte-for-byte
   * identical. `dispatch` (below) is the only caller in normal operation —
   * it wraps this in `mutex.runExclusive(msg.chatId, ...)` for solo/
   * parallel/primary_tool, and calls it directly (no lock) for chatroom.
   */
  /**
   * 守护 v2:这一轮要用的 provider 里,哪些此刻能出发。被挡下的(需要保护 + 网络不安全)
   * 合并成一句统一的话回给发起的那一面(只说一次、不重试),返回剩下能用的。
   */
  async function admitProviders(msg: InboundMsg, providers: ProviderId[]): Promise<ProviderId[]> {
    if (!deps.networkGate) return providers
    const cur = getMode(msg.chatId)
    const allowed: ProviderId[] = []
    const refused: { label: string; source: 'bx' | 'probe' | 'off'; detail: string }[] = []
    for (const p of providers) {
      const model = cur.kind === 'solo' && cur.provider === p ? cur.model : undefined
      // 评审 #193 P1-1:按这一轮**实际**会连到的目标判 —— 有在用的会话就是它起来时定下的端点 + 模型,
      // 没有就是 provider 按这次的模型报的;都报不出来 ⇒ 按需要保护。不按此刻的配置猜。
      const proj = deps.resolveProject(msg.chatId)
      const target = proj && deps.manager.effectiveTarget
        ? deps.manager.effectiveTarget({ alias: proj.alias, providerId: p, chatId: msg.chatId }, model)
        : providerCallTarget(deps.registry.get(p)?.provider, p, 'session', model !== undefined ? { model } : {})
      const d = await decideCall(deps.networkGate, target)
      if (d.allowed) allowed.push(p)
      else refused.push({ label: d.cls.label, source: d.verdict!.source, detail: d.verdict!.detail })
    }
    if (refused.length > 0) {
      const labels = [...new Set(refused.map(r => r.label))].join('、')
      deps.log('GUARD', `chat=${msg.chatId} protected call refused (${labels}) — network unprotected [${refused[0]!.source}] ${refused[0]!.detail}`, { event: 'network_unprotected', chat_id: msg.chatId })
      await notice(msg.chatId, unprotectedMessage(refused[0]!, labels))
    }
    return allowed
  }

  /**
   * parallel / chatroom 这一轮**实际**要执行的参与者:解析参与者,再拿掉此刻不能出发的
   * (需要保护 + 网络不安全,统一回一句话)。null = 全被守护挡下(话已经回过了),这一轮到此为止。
   */
  function resolveAndAdmit(msg: InboundMsg, mode: Mode & { kind: 'parallel' | 'chatroom' }): ProviderId[] | Promise<ProviderId[] | null> {
    const participants = resolveParticipants(mode, msg.chatId)
    // 没接守护就同步返回:不多让出一拍(取消 / latest-wins 抢占都靠同步登记)。
    return participants.length > 0 && deps.networkGate ? admitOrNull(msg, participants) : participants
  }
  async function admitOrNull(msg: InboundMsg, participants: ProviderId[]): Promise<ProviderId[] | null> {
    const admitted = await admitProviders(msg, participants)
    return admitted.length === 0 ? null : admitted
  }

  /**
   * `plan`:submitTurn 已经替 chatroom 算好的实际参与者(为了按实际执行的集合决定排队方式,
   * 评审 #193 P2-4)。只在排队期间模式没变时沿用;否则这里重新算。admitted=null = 全被守护挡下。
   */
  async function dispatchInner(msg: InboundMsg, plan?: { mode: Mode; admitted: ProviderId[] | null }): Promise<void> {
    const proj = deps.resolveProject(msg.chatId)
      if (!proj) {
        deps.log('COORDINATOR', `drop: no project for chat=${msg.chatId}`)
        return
      }
      const mode = getMode(msg.chatId)

      // For parallel/chatroom, resolve the active participant set once.
      // Then degrade-to-solo if the set is ≤1 (no point fanning out to 0
      // or N=1) and use the resolved set for the capability-matrix check.
      let participants: ProviderId[] | null = null
      if (mode.kind === 'parallel' || mode.kind === 'chatroom') {
        // 守护 v2:先拿掉此刻不能出发的(需要保护 + 网络不安全),其余照常;全被挡下就到此为止。
        const planned = plan && JSON.stringify(plan.mode) === JSON.stringify(mode) ? plan.admitted : resolveAndAdmit(msg, mode)
        const resolved = planned instanceof Promise ? await planned : planned
        if (resolved === null) return
        participants = resolved
        if (participants.length === 0) {
          deps.log('COORDINATOR', `chat=${msg.chatId} ${mode.kind} resolved to empty participants; falling back to solo+${deps.defaultProviderId}`)
          return dispatchSolo(msg, proj, deps.defaultProviderId, mode.kind)
        }
        if (participants.length === 1) {
          deps.log('COORDINATOR', `chat=${msg.chatId} ${mode.kind} resolved to single participant ${participants[0]}; degrading to solo`)
          return dispatchSolo(msg, proj, participants[0]!, mode.kind)
        }
      }

      // Capability-matrix guard: reject forbidden (mode × provider × permissionMode)
      // combinations before any session is acquired. All current rows have
      // forbidden=false so this is a forward-looking safety net — it will fire
      // when a row is explicitly marked forbidden in a future policy tightening.
      // Unknown providers (not in the matrix) are silently passed through —
      // the coordinator's own fallback logic handles unregistered providers.
      const providersInUse: ProviderId[] =
        mode.kind === 'solo' ? [mode.provider] :
        mode.kind === 'primary_tool' ? [mode.primary] :
        participants!  // parallel/chatroom — never null here due to early-return above
      for (const p of providersInUse) {
        try {
          assertSupported(mode.kind, p, deps.permissionMode)
        } catch (err) {
          // Re-throw only explicit policy violations (forbidden=true rows).
          // Let unknown-provider errors pass — they're handled downstream
          // by the mode-specific fallback paths in the switch below.
          if (err instanceof UnsupportedCombinationError) throw err
        }
      }

      switch (mode.kind) {
        case 'solo': {
          if (!deps.registry.has(mode.provider)) {
            // Persisted mode references a provider that's no longer
            // registered (e.g. user removed agent). Fall back to default
            // and log loudly so we notice.
            deps.log('COORDINATOR', `chat=${msg.chatId} persisted provider '${mode.provider}' not registered; falling back to ${deps.defaultProviderId}`)
            return dispatchSolo(msg, proj, deps.defaultProviderId)
          }
          return dispatchSolo(msg, proj, mode.provider)
        }
        case 'parallel': {
          return dispatchParallel(msg, proj, participants!)
        }
        case 'primary_tool': {
          // RFC 03 P4 — dispatch to the primary; the peer is reachable
          // via the delegate-mcp tool that's already loaded in the
          // primary's session config. Behaviourally identical to
          // solo+primary at the dispatch layer; the difference is the
          // user's framing (they signalled they want the other AI as
          // a tool) and how the agent uses delegate_<peer>.
          if (!deps.registry.has(mode.primary)) {
            deps.log('COORDINATOR', `chat=${msg.chatId} primary_tool primary '${mode.primary}' not registered; falling back to solo+${deps.defaultProviderId}`)
            return dispatchSolo(msg, proj, deps.defaultProviderId, 'primary_tool')
          }
          return dispatchSolo(msg, proj, mode.primary, 'primary_tool')
        }
        case 'chatroom': {
          return dispatchChatroom(msg, proj, participants!)
        }
      }
    }

  /**
   * D3 — the single turn entrypoint. Resolves the mode's turn policy (see
   * {@link turnPolicy} for the queue-vs-preempt rationale), then runs
   * the turn under it: `preempt` (chatroom) bypasses the mutex (its own
   * abort-on-arrival protocol IS the preemption); `queue` serializes on the
   * per-chat mutex. `opts.within`, when given, runs INSIDE that locked/preempt
   * region and receives the dispatch closure (used by the app path to open a
   * reply-sink, dispatch, and read the captured reply — all under one lock).
   */
  async function submitTurn<T = void>(
    msg: InboundMsg,
    opts?: { within?: (dispatch: () => Promise<void>) => Promise<T> },
  ): Promise<T | void> {
    const mode = getMode(msg.chatId)
    let policy = turnPolicy(mode)
    let plan: { mode: Mode; admitted: ProviderId[] | null } | undefined
    // 评审 #193 P2-4:排队方式跟着**实际执行的集合**走,不跟着模式名走。/chat 被守护筛到只剩
    // 一个(或一个都不剩)时执行已经退成单模型 —— 那就得像 solo 一样排队,否则第二条消息会在
    // 同一个会话上撞上还在跑的第一条(ACP 的 acp_turn_already_running,第二条就丢了)。
    if (policy === 'preempt' && mode.kind === 'chatroom' && deps.resolveProject(msg.chatId)) {
      // 没接守护时同步算(不多让出一拍,latest-wins 的抢占时机不变)。
      const participants = resolveParticipants(mode, msg.chatId)
      // 记下解析之后的模式(老数据第一次解析会回填参与者),dispatchInner 按它判断排队期间模式变没变。
      plan = { mode: getMode(msg.chatId), admitted: participants.length > 0 && deps.networkGate ? await admitOrNull(msg, participants) : participants }
      if (plan.admitted === null || plan.admitted.length < 2) policy = 'queue'
    }
    const run = async (): Promise<T | void> => {
      const doDispatch = (): Promise<void> => dispatchInner(msg, plan)
      return opts?.within ? opts.within(doDispatch) : doDispatch()
    }
    if (policy === 'preempt') {
      // 真的一组人在辩:latest-wins 的抢占照旧(不持锁)。但先等排着队的单模型回合跑完 ——
      // 它们和辩论会用到同一个会话。
      const queued = mutex.tail(msg.chatId)
      if (queued) await queued
      return run()
    }
    // 退成单模型的 /chat:先按 latest-wins 停掉还在跑的整组辩论(和它共用会话),再排队。
    if (mode.kind === 'chatroom') await preemptInFlightChatroom(msg.chatId)
    return mutex.runExclusive(msg.chatId, run)
  }

  /** 停掉这个 chat 正在跑的 /chat 辩论并等它收尾(dispatchChatroom 开头的 latest-wins 同一套)。 */
  async function preemptInFlightChatroom(chatId: string): Promise<void> {
    while (true) {
      const priorAborter = inFlightAborters.get(chatId)
      const priorPromise = inFlightDispatchPromises.get(chatId)
      if (!priorAborter || !priorPromise) return
      deps.log('COORDINATOR_CHATROOM', `chat=${chatId} → preempting prior in-flight dispatch (next turn runs single-model)`)
      priorAborter.abort()
      try { await priorPromise } catch { /* prior dispatch's own error path */ }
    }
  }

  // Back-compat thin wrapper — the WeChat inbound path. Identical behavior to
  // the old mode-branching dispatch, now expressed via submitTurn's policy.
  async function dispatch(msg: InboundMsg): Promise<void> {
    await submitTurn(msg)
  }

  return {
    submitTurn,
    getMode,
    setMode(chatId, mode) {
      validateMode(mode)
      const oldMode = getMode(chatId)
      deps.conversationStore.set(chatId, mode)
      // 换 provider 交接:solo→solo 且 provider 变化时标记。同 provider 换
      // 模型不换会话线(session key 含 provider 不含 model),无需交接。
      if (oldMode.kind === 'solo' && mode.kind === 'solo' && oldMode.provider !== mode.provider) {
        handoffLedger.markSwitch(chatId, oldMode.provider, mode.provider)
      }
      // 同 provider 换钉模型:session 缓存键里没有 model,不放掉旧会话它就
      // 一直在旧模型上答 ——「说了换、没换」。best-effort,失败只记日志。
      if (oldMode.kind === 'solo' && mode.kind === 'solo' && oldMode.provider === mode.provider && oldMode.model !== mode.model) {
        void deps.manager.releaseFor?.(mode.provider, chatId).catch(err => {
          deps.log('COORDINATOR', `releaseFor after model pin change failed chat=${chatId}: ${err instanceof Error ? err.message : String(err)}`)
        })
      }
    },
    cancel(chatId) {
      let cancelledAny = false
      const ac = inFlightAborters.get(chatId)
      if (ac) {
        ac.abort()
        // delete is done in dispatchChatroom's finally; double-delete is harmless.
        cancelledAny = true
      }
      // Post-cancel-review CRITICAL 1 — solo/parallel/primary_tool turns
      // have no aborter loop, but their acquired SessionHandle(s) do
      // support cancel(); invoke every in-flight one for this chat.
      const handleCancels = inFlightHandleCancels.get(chatId)
      if (handleCancels && handleCancels.size > 0) {
        for (const fn of handleCancels) fn()
        cancelledAny = true
      }
      return cancelledAny
    },
    runExclusive: mutex.runExclusive,
    dispatch,
  }
}
