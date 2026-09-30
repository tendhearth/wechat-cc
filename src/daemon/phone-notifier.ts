/**
 * phone-notifier.ts — 判断「该叫醒手机了」(spec 2026-09-30 §5「发送」第 1 步)。
 *
 * 不另造信号:像一台手机一样订阅事件集线器的 `approvals` 与 `agents` 两个主题(同一份摘要、同一套
 * poke),比较前后两份快照 —— 新的待批准 / 待回答、任务本轮做完(working → replied)、任务失败。
 * 第一份快照只做基线(daemon 重启不补发)。有登记设备才订阅,没有就退订,别让集线器空转。
 * 正在用实时订阅连着的手机不推(它自己看得见)。
 */
import type { PhoneEvents } from './phone-events'
import type { ApprovalSummary } from './phone-topic-sources'
import type { PhonePush, PushPayload } from './phone-push'

type AgentsSnap = { tasks: Array<{ id: string; title: string; phase: string }> }

export function makePhoneNotifier(deps: {
  events: Pick<PhoneEvents, 'subscribe'>
  push: Pick<PhonePush, 'registered' | 'notify'>
  subscribedDevices(): Set<string>
  taskInfo(taskId: string): { title: string; status: string } | null
  log: (tag: string, line: string) => void
}): { refresh(): void; dispose(): void } {
  let offs: Array<() => void> = []
  let approvalsSeen: Set<string> | null = null
  let agentsPrev: Map<string, { title: string; phase: string }> | null = null

  function fanout(p: PushPayload): void {
    const online = deps.subscribedDevices()
    for (const id of deps.push.registered()) {
      if (online.has(id)) continue
      if (!deps.push.notify(id, p)) deps.log('PUSH', `notify ${p.kind} → ${id} not sent (relay offline / unregistered)`)
    }
  }

  function onApprovals(data: unknown): void {
    const list = Array.isArray(data) ? data as ApprovalSummary[] : []
    const keys = new Map(list.map(a => [`${a.taskId}:${a.kind}:${a.id}`, a]))
    const prev = approvalsSeen
    approvalsSeen = new Set(keys.keys())
    if (!prev) return
    for (const [k, a] of keys) {
      if (prev.has(k)) continue
      const title = deps.taskInfo(a.taskId)?.title ?? ''
      fanout({
        kind: a.kind,
        title: a.kind === 'permission' ? '需要你批准' : 'CC 有问题问你',
        body: title ? `${title}:${a.summary}` : a.summary,
        taskId: a.taskId,
      })
    }
  }

  function onAgents(data: unknown): void {
    const tasks = (data as AgentsSnap | null)?.tasks ?? []
    const cur = new Map(tasks.map(t => [t.id, { title: t.title, phase: t.phase }]))
    const prev = agentsPrev
    agentsPrev = cur
    if (!prev) return
    for (const [id, t] of cur) {
      const was = prev.get(id)?.phase
      if (t.phase === 'replied' && (was === 'working' || was === 'queued')) fanout({ kind: 'task_done', title: '做完了', body: t.title, taskId: id })
      else if ((t.phase === 'failed' || t.phase === 'interrupted') && was !== t.phase) fanout({ kind: 'task_failed', title: '没做成', body: t.title, taskId: id })
    }
    for (const [id, was] of prev) {
      if (cur.has(id)) continue
      const info = deps.taskInfo(id)
      if (!info) continue
      if (info.status === 'completed' && was.phase !== 'replied') fanout({ kind: 'task_done', title: '做完了', body: info.title, taskId: id })
      else if (info.status === 'failed' || info.status === 'interrupted') fanout({ kind: 'task_failed', title: '没做成', body: info.title, taskId: id })
    }
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
          deps.events.subscribe('approvals', undefined, ev => onApprovals(ev.data)),
          deps.events.subscribe('agents', undefined, ev => onAgents(ev.data)),
        ]
      } else if (!want && offs.length > 0) {
        stop()
      }
    },
    dispose: stop,
  }
}
