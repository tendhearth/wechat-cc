import type { ApprovalItemT, AgentsTopicT, MatterT } from '../backend/types'
import { statusOf, type StatusKey } from './status'

export function matterStatus(m: MatterT, agents: AgentsTopicT, pending: number): StatusKey {
  const t = agents.tasks.find(x => x.id === m.id)
  if (t) return statusOf({ status: 'running', phase: t.phase }, pending)
  if (pending > 0) return 'waiting'
  if (m.status === 'replied') return 'replied'
  if (m.status === 'done' || m.status === 'archived') return 'done'
  return 'working'
}

export function nowView(input: { approvals: ApprovalItemT[]; agents: AgentsTopicT; matters: MatterT[]; hour: number }): {
  greetingKey: 'now.greetingMorning' | 'now.greetingAfternoon' | 'now.greetingEvening'
  needsYou: Array<{ taskId: string; count: number; firstSummary: string }>
  together: Array<{ id: string; title: string; status: StatusKey; updatedAt: number }>
} {
  const { approvals, agents, matters, hour } = input
  const greetingKey = hour >= 5 && hour <= 11 ? 'now.greetingMorning' : hour >= 12 && hour <= 17 ? 'now.greetingAfternoon' : 'now.greetingEvening'
  const groups = new Map<string, { taskId: string; count: number; firstSummary: string }>()
  for (const a of approvals) {
    const g = groups.get(a.taskId)
    if (g) g.count++
    else groups.set(a.taskId, { taskId: a.taskId, count: 1, firstSummary: a.summary })
  }
  const pendingBy = (id: string) => groups.get(id)?.count ?? 0
  const together = matters
    .filter(m => m.status !== 'archived')
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 5)
    .map(m => ({ id: m.id, title: m.title, status: matterStatus(m, agents, pendingBy(m.id)), updatedAt: m.updatedAt }))
  return { greetingKey, needsYou: [...groups.values()], together }
}
