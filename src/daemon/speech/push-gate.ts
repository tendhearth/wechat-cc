/**
 * App 原生推送也问 CC 开口那道门(第三批 3a)。
 *
 * 推送是一条通道,但工作台的「等你批准 / CC 有问题问你 / 做完了 / 没做成」和终端会话的「等你批准 / 完成了」
 * 不是哪一轮 say 的产物 —— 它们由工作台 / 终端会话的状态变化直接触发(phone-notifier、cli-events 的 hub)。
 * 不过门,主人设了免打扰,微信那句「做完了」推到天亮,手机却半夜响。所以这些推送按内容归类后问门(policy.ask):
 *  - permission / question ⇒ permission_ask(blocking:免打扰、别烦我都照推);
 *  - task_done / task_failed ⇒ matter_report(report:免打扰里先压着,时段结束再问)。
 * companion 不经这里:它只由 proactive-channel 在 say 开的那一轮收尾时推(已经过了门)。
 *
 * 压着的推送落在主库 `speech_pending`(lane = 'push',held-pushes.ts;S2b):同一件事只留最新那一条,到点再问一次门;
 * **重启不丢**(主人 11-04 拍板)—— 开机时按表里最早的到点时刻起计时器。每一条有过期时间(24 小时):过了记一行账
 * 「过期作废」,不推(那件事本身在 App 的列表里照样看得见)。每一拍最多放几条,剩下的一秒后接着放。
 * 推送送不送得到是推送自己的事(在线的跳过、没设备就是 0 台),所以问门时 deliverable 恒为 true,微信断没断跟它无关;
 * 到点时中继还没连上(刚开机)⇒ 先不放,过一会儿再看(只看本地状态,不碰网络)。「待说」那一拍(policy.onFlush)也顺手
 * 再问一次门:主人提前关了免打扰,压着的不必等到原来的时段结束。
 */
import type { SpeechKind } from '../../domain/speech/kinds'
import type { PushPayload } from '../../features/phone'
import { RETRY_WINDOW_MS } from '../../lib/delivery-backoff'
import type { HeldPushes } from './held-pushes'
import type { SpeechPolicy } from './policy'

export const MAX_HELD_PUSHES = 50
/** 一拍最多放几条压着的推送(静音一结束不一口气响一串)。 */
export const MAX_RELEASE_PER_TICK = 5
/** 到点了但中继还没连上:多久再看一次(本地状态,不算尝试)。 */
export const NOT_READY_RECHECK_MS = 30_000
/** setTimeout 的上限(约 24.8 天),超过会被当成立刻触发。 */
const MAX_TIMER_MS = 2 ** 31 - 1

export function pushSpeechKind(kind: PushPayload['kind']): SpeechKind | null {
  if (kind === 'permission' || kind === 'question') return 'permission_ask'
  if (kind === 'task_done' || kind === 'task_failed') return 'matter_report'
  return null
}

type PushResult = { sent: number; online: number } | null

export interface PushGate {
  /** 问门;放行 ⇒ 原样推、回推送的结果;压着 ⇒ 回 {sent:0, online:0}。没接推送 ⇒ null。 */
  push(p: PushPayload): PushResult
  /** 停计时器。压着的留在表里,下次开机接着等。 */
  stop(): void
}

export function makePushGate(d: {
  speech: Pick<SpeechPolicy, 'ask' | 'expired'> & Partial<Pick<SpeechPolicy, 'onFlush'>>
  /** 免打扰 / 别烦我都挂在主人那条对话上;没有主人对话 ⇒ 没有可守的设置,照推。 */
  ownerChatId(): string | null
  /** 发送本身(fanoutPush)。 */
  push(p: PushPayload): PushResult
  /** 压着的推送(主库 speech_pending lane='push')。 */
  held: HeldPushes
  /** 中继连着没有(放压着的推送之前看一眼;缺省 = 连着)。 */
  ready?: () => boolean
  log: (tag: string, line: string) => void
  now?: () => number
  setTimer?: (cb: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
}): PushGate {
  const now = d.now ?? Date.now
  const setTimer = d.setTimer ?? ((cb, ms) => { const t = setTimeout(cb, ms); (t as { unref?: () => void }).unref?.(); return t })
  const clearTimer = d.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>))
  let timer: unknown = null
  let stopped = false

  const arm = (): void => {
    if (timer !== null) { clearTimer(timer); timer = null }
    if (stopped) return
    const due = d.held.nextDue()
    if (due === null) return
    timer = setTimer(() => { timer = null; release() }, Math.min(MAX_TIMER_MS, Math.max(1_000, due - now())))
  }

  /** 问门。放行 ⇒ 推;推后 ⇒ 记下到点时刻;(blocking / report 不会被拒;万一被拒 ⇒ 记一行,不推。) */
  const attempt = (p: PushPayload): { pushed: PushResult } | { until: number; kind: SpeechKind; chat: string } | { dropped: string } => {
    const kind = pushSpeechKind(p.kind)
    const chat = d.ownerChatId()
    if (!kind || !chat) return { pushed: d.push(p) }
    const o = d.speech.ask({ kind, chatId: chat }, { channel: 'app', deliverable: true })
    if ('allow' in o) return { pushed: d.push(p) }
    if ('drop' in o) return { dropped: o.reason }
    const until = o.until ? Date.parse(o.until) : NaN
    return { until: Number.isFinite(until) ? until : now() + 5 * 60_000, kind, chat }
  }

  /** 放到点的那几条;recheck = 「待说」那一拍顺手来问:没到点的也再问一次门(主人提前关了免打扰就不必等)。 */
  function release(recheck = false): void {
    if (stopped) return
    try {
      const t = now()
      for (const x of d.held.expire(t)) {
        d.speech.expired({ kind: x.kind, chatId: x.chatId, channel: 'app' })
        d.log('PUSH', `held ${x.payload.kind} push expired — not pushed (${x.key})`)
      }
      const due = d.held.due(recheck ? Number.MAX_SAFE_INTEGER : t, MAX_RELEASE_PER_TICK)
      if (due.length > 0 && d.ready && !d.ready()) {
        for (const h of due) d.held.reschedule(h.id, t + NOT_READY_RECHECK_MS)
        d.log('PUSH', `${due.length} held push(es) due but the relay is not connected yet — checking again in ${NOT_READY_RECHECK_MS / 1000}s`)
      } else {
        for (const h of due) {
          const r = attempt(h.payload)
          if ('until' in r) { d.held.reschedule(h.id, r.until); continue }
          d.held.remove(h.id)
          if ('pushed' in r) d.log('PUSH', `held ${h.payload.kind} push released (${h.key})`)
          else d.log('PUSH', `held ${h.payload.kind} push dropped on release (${h.key}): ${r.dropped}`)
        }
      }
    } catch (err) {
      d.log('PUSH', `releasing held pushes failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    arm()
  }

  d.speech.onFlush?.(() => release(true))
  // 开机:表里有上次压着的 ⇒ 按最早的到点时刻起计时器(重启不丢)
  try { arm() } catch (err) { d.log('PUSH', `held pushes not armed at start: ${err instanceof Error ? err.message : String(err)}`) }

  return {
    push(p) {
      if (stopped) return null
      const r = attempt(p)
      if ('pushed' in r) return r.pushed
      if ('dropped' in r) { d.log('PUSH', `${p.kind} push dropped by speech policy: ${r.dropped}`); return { sent: 0, online: 0 } }
      const key = `${p.kind}:${p.taskId ?? ''}:${p.requestId ?? ''}`
      const t = now()
      try {
        d.held.hold({ key, kind: r.kind, chatId: r.chat, payload: p, until: r.until, expiresAt: t + RETRY_WINDOW_MS, at: t })
        for (const oldest of d.held.trim(MAX_HELD_PUSHES)) d.log('PUSH', `held pushes over ${MAX_HELD_PUSHES} — dropped the oldest (${oldest}); the task itself is still in the app`)
      } catch (err) {
        d.log('PUSH', `${p.kind} push not held (store failed): ${err instanceof Error ? err.message : String(err)}`)
        return { sent: 0, online: 0 }
      }
      d.log('PUSH', `${p.kind} push held by speech policy until ${new Date(r.until).toISOString()}`)
      arm()
      return { sent: 0, online: 0 }
    },
    stop() {
      stopped = true
      if (timer !== null) { clearTimer(timer); timer = null }
    },
  }
}
