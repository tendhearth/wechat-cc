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
 * 压着的推送只在内存里(同一件事只留最新那一条),到时段结束再问一次;重启就没了 —— 跟 phone-notifier
 * 「第一份快照只做基线、重启不补发」一致,那件事本身在 App 的列表里照样看得见。推送送不送得到是推送自己的事
 * (在线的跳过、没设备就是 0 台),所以问门时 deliverable 恒为 true,微信断没断跟它无关。
 */
import type { SpeechKind } from '../../core/speech/kinds'
import type { PushPayload } from '../phone-push'
import type { SpeechPolicy } from './policy'

export const MAX_HELD_PUSHES = 50

export function pushSpeechKind(kind: PushPayload['kind']): SpeechKind | null {
  if (kind === 'permission' || kind === 'question') return 'permission_ask'
  if (kind === 'task_done' || kind === 'task_failed') return 'matter_report'
  return null
}

type PushResult = { sent: number; online: number } | null

export interface PushGate {
  /** 问门;放行 ⇒ 原样推、回推送的结果;压着 ⇒ 回 {sent:0, online:0}。没接推送 ⇒ null。 */
  push(p: PushPayload): PushResult
  stop(): void
}

export function makePushGate(d: {
  speech: Pick<SpeechPolicy, 'ask'>
  /** 免打扰 / 别烦我都挂在主人那条对话上;没有主人对话 ⇒ 没有可守的设置,照推。 */
  ownerChatId(): string | null
  /** 发送本身(fanoutPush)。 */
  push(p: PushPayload): PushResult
  log: (tag: string, line: string) => void
  now?: () => number
  setTimer?: (cb: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
}): PushGate {
  const now = d.now ?? Date.now
  const setTimer = d.setTimer ?? ((cb, ms) => { const t = setTimeout(cb, ms); (t as { unref?: () => void }).unref?.(); return t })
  const clearTimer = d.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>))
  const held = new Map<string, { p: PushPayload; until: number }>()
  let timer: unknown = null
  let stopped = false

  const arm = (): void => {
    if (timer !== null) { clearTimer(timer); timer = null }
    if (stopped || held.size === 0) return
    const due = Math.min(...[...held.values()].map(h => h.until))
    timer = setTimer(() => { timer = null; release() }, Math.max(1_000, due - now()))
  }

  /** 问门。放行 ⇒ 推;推后 ⇒ 记下到点时刻;(blocking / report 不会被拒;万一被拒 ⇒ 记一行,不推。) */
  const attempt = (p: PushPayload): { pushed: PushResult } | { until: number } | { dropped: string } => {
    const kind = pushSpeechKind(p.kind)
    const chat = d.ownerChatId()
    if (!kind || !chat) return { pushed: d.push(p) }
    const o = d.speech.ask({ kind, chatId: chat }, { channel: 'app', deliverable: true })
    if ('allow' in o) return { pushed: d.push(p) }
    if ('drop' in o) return { dropped: o.reason }
    const until = o.until ? Date.parse(o.until) : NaN
    return { until: Number.isFinite(until) ? until : now() + 5 * 60_000 }
  }

  function release(): void {
    const items = [...held.entries()]
    held.clear()
    for (const [key, h] of items) {
      if (now() < h.until) { held.set(key, h); continue }
      const r = attempt(h.p)
      if ('until' in r) held.set(key, { p: h.p, until: r.until })
      else if ('pushed' in r) d.log('PUSH', `held ${h.p.kind} push released (${key})`)
    }
    arm()
  }

  return {
    push(p) {
      if (stopped) return null
      const r = attempt(p)
      if ('pushed' in r) return r.pushed
      if ('dropped' in r) { d.log('PUSH', `${p.kind} push dropped by speech policy: ${r.dropped}`); return { sent: 0, online: 0 } }
      const key = `${p.kind}:${p.taskId ?? ''}:${p.requestId ?? ''}`
      held.delete(key)
      held.set(key, { p, until: r.until })
      while (held.size > MAX_HELD_PUSHES) {
        const oldest = held.keys().next().value as string
        held.delete(oldest)
        d.log('PUSH', `held pushes over ${MAX_HELD_PUSHES} — dropped the oldest (${oldest}); the task itself is still in the app`)
      }
      d.log('PUSH', `${p.kind} push held by speech policy until ${new Date(r.until).toISOString()}`)
      arm()
      return { sent: 0, online: 0 }
    },
    stop() {
      stopped = true
      if (timer !== null) { clearTimer(timer); timer = null }
      held.clear()
    },
  }
}
