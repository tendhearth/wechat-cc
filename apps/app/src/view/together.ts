import type { ApprovalItemT, AgentsTopicT, MatterT } from '../backend/types'
import { matterStatus } from './now'
import type { StatusKey } from './status'

export function togetherView(matters: MatterT[], approvals: ApprovalItemT[], agents: AgentsTopicT): Array<{ id: string; title: string; status: StatusKey; subtitle: string }> {
  const first = new Map<string, { n: number; summary: string }>()
  for (const a of approvals) {
    const f = first.get(a.taskId)
    if (f) f.n++
    else first.set(a.taskId, { n: 1, summary: a.summary })
  }
  return matters
    .filter(m => m.status !== 'archived')
    .map(m => {
      const f = first.get(m.id)
      return { m, status: matterStatus(m, agents, f?.n ?? 0), subtitle: f ? f.summary : (m.projectPath ?? '') }
    })
    .sort((a, b) => (Number(b.status === 'waiting') - Number(a.status === 'waiting')) || b.m.updatedAt - a.m.updatedAt)
    .map(({ m, status, subtitle }) => ({ id: m.id, title: m.title, status, subtitle }))
}
