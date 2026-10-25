/**
 * phone-notifier.ts — 判断「该叫醒手机了」(spec 2026-09-30 §5「发送」第 1 步)。
 *
 * 不另造信号:像一台手机一样订阅事件集线器的 `approvals` 与 `agents` 两个主题(同一份摘要、同一套
 * poke),比较前后两份快照 —— 新的待批准 / 待回答、任务本轮做完(working → replied)、任务失败。
 * 第一份快照只做基线(daemon 重启不补发)。有登记设备才订阅,没有就退订,别让集线器空转。
 * 正在用实时订阅连着的手机不推(它自己看得见)。推送经 deps.deliver —— 接线处让它先问 CC 开口那道门。
 */
import type { PhoneEvents } from './phone-events'
import type { ApprovalSummary } from './phone-topic-sources'
import type { PhonePush, PushPayload } from './phone-push'

/**
 * 一条推送发给每台登记过的手机;正连着实时订阅的跳过(它自己看得见)。单台失败只记日志、不重试。
 * 回 sent = 交给中继的台数、online = 因在线跳过的台数(调用方据此判断「手机够得着」)。
 * phone-notifier 与终端会话推送(features/terminal/app-push.ts)共用这一个。
 */
export function fanoutPush(deps: {
  push: Pick<PhonePush, 'registered' | 'notify'>
  subscribedDevices(): Set<string>
  log: (tag: string, line: string) => void
}, p: PushPayload): { sent: number; online: number } {
  const online = deps.subscribedDevices()
  let sent = 0, skipped = 0
  for (const id of deps.push.registered()) {
    if (online.has(id)) { skipped++; continue }
    try {
      if (deps.push.notify(id, p)) sent++
      else deps.log('PUSH', `notify ${p.kind} → ${id} not sent (relay offline / unregistered)`)
    } catch (e) {
      deps.log('PUSH', `notify ${p.kind} → ${id} threw: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return { sent, online: skipped }
}

type AgentsSnap = { tasks: Array<{ id: string; title: string; phase: string }> }

export function makePhoneNotifier(deps: {
  events: Pick<PhoneEvents, 'subscribe'>
  /** 只用来判断要不要订阅(有登记设备才订阅)。 */
  push: Pick<PhonePush, 'registered'>
  /**
   * 推一条。接线处给的是问过 CC 开口那道门的推送(speech/push-gate.ts:批准 / 提问 = blocking,做完 / 没做成 =
   * report,免打扰里先压着)—— 这里不直接调 fanoutPush,免得绕过门。
   */
  deliver(p: PushPayload): void
  taskInfo(taskId: string): { title: string; status: string } | null
  log: (tag: string, line: string) => void
}): { refresh(): void; dispose(): void } {
  let offs: Array<() => void> = []
  let approvalsSeen: Set<string> | null = null
  let agentsPrev: Map<string, { title: string; phase: string }> | null = null

  const fanout = (p: PushPayload): void => { deps.deliver(p) }

  // 一条事件失败不连累其余;整个 fanout(registered / subscribedDevices 抛)也不许冒出去。
  function safeFanout(mk: () => PushPayload | null): void {
    try { const p = mk(); if (p) fanout(p) } catch (e) { deps.log('PUSH', `fanout threw: ${e instanceof Error ? e.message : String(e)}`) }
  }

  function onApprovals(data: unknown): void {
    const list = (Array.isArray(data) ? data : []).filter((a): a is ApprovalSummary =>
      !!a && typeof a === 'object' && typeof (a as ApprovalSummary).taskId === 'string' && typeof (a as ApprovalSummary).id === 'string'
      && ((a as ApprovalSummary).kind === 'permission' || (a as ApprovalSummary).kind === 'question'))
    const keys = new Map(list.map(a => [`${a.taskId}:${a.kind}:${a.id}`, a]))
    const prev = approvalsSeen
    approvalsSeen = new Set(keys.keys())
    if (!prev) return
    for (const [k, a] of keys) {
      if (prev.has(k)) continue
      safeFanout(() => {
        const title = deps.taskInfo(a.taskId)?.title ?? ''
        return {
          kind: a.kind,
          title: a.kind === 'permission' ? '需要你批准' : 'CC 有问题问你',
          body: title ? `${title}:${a.summary}` : a.summary,
          taskId: a.taskId,
          requestId: a.id,
        }
      })
    }
  }

  function onAgents(data: unknown): void {
    const raw = (data as AgentsSnap | null)?.tasks
    const tasks = (Array.isArray(raw) ? raw : []).filter(t => !!t && typeof t === 'object' && typeof t.id === 'string')
    const cur = new Map(tasks.map(t => [t.id, { title: t.title, phase: t.phase }]))
    const prev = agentsPrev
    agentsPrev = cur
    if (!prev) return
    for (const [id, t] of cur) {
      const was = prev.get(id)?.phase
      if (t.phase === 'replied' && (was === 'working' || was === 'queued')) safeFanout(() => ({ kind: 'task_done', title: '做完了', body: t.title, taskId: id }))
      else if ((t.phase === 'failed' || t.phase === 'interrupted') && was !== t.phase) safeFanout(() => ({ kind: 'task_failed', title: '没做成', body: t.title, taskId: id }))
    }
    for (const [id, was] of prev) {
      if (cur.has(id)) continue
      safeFanout(() => {
        const info = deps.taskInfo(id)
        if (!info) return null
        if (info.status === 'completed' && was.phase !== 'replied') return { kind: 'task_done', title: '做完了', body: info.title, taskId: id }
        if (info.status === 'failed' || info.status === 'interrupted') return { kind: 'task_failed', title: '没做成', body: info.title, taskId: id }
        return null
      })
    }
  }

  function guard(topic: string, f: () => void): void {
    try { f() } catch (e) { deps.log('PUSH', `${topic} handler threw: ${e instanceof Error ? e.message : String(e)}`) }
  }

  function stop(): void {
    for (const off of offs) { try { off() } catch { /* 集线器自己的事 */ } }
    offs = []
    approvalsSeen = null
    agentsPrev = null
  }

  return {
    refresh() {
      const want = deps.push.registered().length > 0
      if (want && offs.length === 0) {
        offs = [
          deps.events.subscribe('approvals', undefined, ev => guard('approvals', () => onApprovals(ev.data))),
          deps.events.subscribe('agents', undefined, ev => guard('agents', () => onAgents(ev.data))),
        ]
      } else if (!want && offs.length > 0) {
        stop()
      }
    },
    dispose: stop,
  }
}
