/**
 * TurnRunner:跑**一位**执行者的**一轮**时,三种派法(solo / /both / /chat 的一拍)都要的那套机器,只有这一份:
 *  - 同一个底层会话同一时刻只有一个回合(oneTurnPerSession);
 *  - 超时(daemon 的回合看门狗;/chat 一拍最多 120 秒);
 *  - 事件转发(桌宠的「它在干什么」);
 *  - 长任务进度(一轮超过阈值还没完,发一次);
 *  - 取消登记(/stop 够得着正在跑的会话;/chat 的 aborter 抢占也够得着);
 *  - 一轮的结构化记录(TurnRecord)。
 * 派法只管编排:什么时候 acquire、prompt 怎么拼、出错怎么说、交付走哪条路。
 */
import type { ProviderId } from '../conversation'
import type { SessionHandle } from '../session-manager'
import { collectTurn, TURN_TIMEOUT_CODE, type AgentEvent, type TurnSummary } from '../agent-provider'
import { isAuthErrorCode } from '../../lib/provider-error-code'
import type { DeliveryReport } from '../turn-reply'
import type { CoordinatorCtx } from './ctx'
import type { TurnRecord } from './types'

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

export interface RunTurn {
  chatId: string
  alias: string
  /** 会话锁的键用它(和 SessionManager 的会话键同一个粒度)。 */
  providerId: ProviderId
  handle: Pick<SessionHandle, 'dispatch'>
  prompt: string
  /** 'turn' = daemon 的回合看门狗(deps.turnTimeoutMs,缺省不限);'beat' = /chat 的一拍。 */
  budget: 'turn' | 'beat'
  /** 这一轮自己还要看事件(solo 的 daemon 交付收旁白)。先于桌宠的 onTurnEvent。 */
  observe?: (ev: AgentEvent) => void
  /** 一轮超过阈值还没完时调一次(一轮最多一次)。 */
  progress?: () => void
}

export interface TurnRecordInput {
  chatId: string
  provider: ProviderId
  alias: string
  mode: TurnRecord['mode']
  startedAt: number
  endedAt: number
  outcome: TurnRecord['outcome']
  summary: TurnSummary | undefined
  /** summary 里没有 error 时的补充(acquire / 回合抛出来的)。 */
  error?: string
  report?: DeliveryReport
}

export interface TurnRunner {
  run(t: RunTurn): Promise<TurnSummary>
  /** /stop 够得着这个会话:登记它的 cancel,返回注销。 */
  registerCancel(chatId: string, cancel: () => void): () => void
  /** /chat:这一轮的 aborter 一响就取消这个会话(已经响过就当场取消)。返回解绑。 */
  linkAbort(signal: AbortSignal | undefined, cancel: () => void): () => void
  /** 一轮开始时记下;之后调它 ⇒ 这一轮被主人中止过。 */
  stopMark(chatId: string): () => boolean
  /** coordinator.cancel 的会话那一半:取消这个 chat 所有登记着的会话。有就 true。 */
  cancelHandles(chatId: string): boolean
  /** 记一次 /stop(cancel 真的够着了东西才记)。 */
  markStopped(chatId: string): void
  /** summary(或抛出)→ 这一轮的结局。 */
  outcomeOf(summary: TurnSummary | undefined, threw: boolean): TurnRecord['outcome']
  record(r: TurnRecordInput): void
}

/**
 * TurnRecord 的交付列 —— solo、/both、/chat 三处同一个写法(spec §4.10)。只有真的交付过(completed)
 * 才有 report;超时 / 出错 / 中止的轮不填。
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

export function createTurnRunner(ctx: CoordinatorCtx): TurnRunner {
  const { deps } = ctx

  // 第二轮评审 #194 P2:**同一个底层会话同一时刻只有一个回合**。按 (chat, project, provider) —— 和
  // SessionManager 的会话键同一个粒度 —— 串行每一次发送:单模型队列(per-chat 锁)和 /chat
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

  // Post-cancel-review CRITICAL 1 — chatroom's own preempt-loop AbortController
  // has no analogue for solo/parallel/primary_tool: those are single-shot
  // dispatches with no round-boundary loop to abort, but the SessionHandle they
  // acquire from SessionManager DOES support cancel() (forwards to the
  // provider's AgentSession.cancel — see session-manager.ts). Without this,
  // coordinator.cancel() (and therefore /stop) was a no-op for every mode
  // except chatroom, even though every provider now implements cancel().
  // chatId → the set of in-flight handles' cancel closures (a Set, not a
  // single slot, because dispatchParallel acquires N handles concurrently
  // for one chatId). Registered right after acquire, unregistered when the
  // turn settles — same lifecycle shape as the chatroom aborters.
  const inFlightHandleCancels = new Map<string, Set<() => void>>()
  // /stop 的代数(2026-10-10):cancel() 每次 +1;一轮开始时记下、结束时比对 ⇒ 这一轮被主人中止过。
  // 中止过的轮不发出错通知、不交付半截话 —— 各家 provider 中止后的收尾不一样(报 error / 像正常结束)。
  const cancelGen = new Map<string, number>()

  return {
    run(t) {
      // 进度从这一轮开始算(含排在会话锁后面等的那段),和回合一起收尾。
      let progressTimer: ReturnType<typeof setTimeout> | undefined
      if (t.progress) {
        const fire = t.progress
        progressTimer = setTimeout(() => { progressTimer = undefined; fire() }, deps.replyProgressAfterMs ?? LONG_TURN_PROGRESS_MS)
      }
      const timeoutMs = t.budget === 'beat'
        ? Math.min(deps.turnTimeoutMs ?? CHATROOM_BEAT_TIMEOUT_MS, CHATROOM_BEAT_TIMEOUT_MS)
        : deps.turnTimeoutMs
      const observe = t.observe
      const onEvent = observe
        ? (ev: AgentEvent) => { observe(ev); deps.onTurnEvent?.(t.chatId, ev) }
        : (ev: AgentEvent) => deps.onTurnEvent?.(t.chatId, ev)
      const turn = oneTurnPerSession(t.chatId, t.alias, t.providerId, () => collectTurn(t.handle.dispatch(t.prompt), { timeoutMs, onEvent }))
      if (progressTimer) {
        // 旁路收尾,不多套一层 then:调用方 await 的还是回合本身,恢复的那一拍不变。
        const clear = () => { if (progressTimer) { clearTimeout(progressTimer); progressTimer = undefined } }
        void turn.then(clear, clear)
      }
      return turn
    },

    registerCancel(chatId, cancel) {
      let set = inFlightHandleCancels.get(chatId)
      if (!set) { set = new Set(); inFlightHandleCancels.set(chatId, set) }
      set.add(cancel)
      return () => {
        set!.delete(cancel)
        if (set!.size === 0) inFlightHandleCancels.delete(chatId)
      }
    },

    linkAbort(signal, cancel) {
      if (!signal) return () => {}
      // 拍与拍之间才看 aborter 不够:一拍里慢的那位会跑满整拍超时,抢占的新消息也得干等。
      if (signal.aborted) { cancel(); return () => {} }
      signal.addEventListener('abort', cancel, { once: true })
      return () => signal.removeEventListener('abort', cancel)
    },

    stopMark(chatId) {
      const g = cancelGen.get(chatId) ?? 0
      return () => (cancelGen.get(chatId) ?? 0) !== g
    },

    cancelHandles(chatId) {
      const handleCancels = inFlightHandleCancels.get(chatId)
      if (!handleCancels || handleCancels.size === 0) return false
      for (const fn of handleCancels) fn()
      return true
    },

    markStopped(chatId) {
      cancelGen.set(chatId, (cancelGen.get(chatId) ?? 0) + 1)
    },

    outcomeOf(summary, threw) {
      return threw ? 'error'
        : summary?.errorCode === TURN_TIMEOUT_CODE ? 'timeout'
        : isAuthErrorCode(summary?.errorCode) ? 'auth_failed'
        : summary?.error ? 'error'
        : 'completed'
    },

    // One structured TurnRecord per provider turn — the AI-legible / human-legible trace that
    // makes "why did chat X stop replying at HH:MM" a query, not a log dig.
    record(r) {
      deps.recordTurn?.({
        chatId: r.chatId,
        provider: r.provider,
        alias: r.alias,
        mode: r.mode,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        durationMs: r.endedAt - r.startedAt,
        outcome: r.outcome,
        replyToolCalled: r.summary?.replyToolCalled ?? false,
        toolCalls: r.summary?.toolCalls ?? [],
        textChunks: r.summary?.assistantText.length ?? 0,
        error: r.summary?.error ?? r.error,
        errorCode: r.summary?.errorCode,
        ...deliveryColumns(r.report, r.summary),
      })
    },
  }
}
