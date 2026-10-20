import type { ApprovalItemT, AgentsTopicT, MatterT } from '../backend/types'
import { matterStatus } from './now'
import type { StatusKey } from './status'
import { matterOrigin, type MatterOrigin } from './origin'

export function togetherView(matters: MatterT[], approvals: ApprovalItemT[], agents: AgentsTopicT): Array<{ id: string; title: string; status: StatusKey; subtitle: string; agents: string[]; origin: MatterOrigin | null }> {
  const first = new Map<string, { n: number; summary: string }>()
  for (const a of approvals) {
    const f = first.get(a.taskId)
    if (f) f.n++
    else first.set(a.taskId, { n: 1, summary: a.summary })
  }
  return matters
    // 主人对话在顶上单独置顶;访客的聊天是 CC 的社交,不是一起做的事(spec 2026-10-01 §2)
    .filter(m => m.status !== 'archived' && m.kind !== 'chat')
    .map(m => {
      const f = first.get(m.id)
      return { m, status: matterStatus(m, agents, f?.n ?? 0), subtitle: f ? f.summary : (m.projectPath ?? '') }
    })
    .sort((a, b) => (Number(b.status === 'waiting') - Number(a.status === 'waiting')) || b.m.updatedAt - a.m.updatedAt)
    .map(({ m, status, subtitle }) => ({ id: m.id, title: m.title, status, subtitle, agents: m.agents ?? [], origin: matterOrigin(m.origin) }))
}

export type TogetherRow = ReturnType<typeof togetherView>[number]
export type TogetherGroupKey = 'waiting' | 'working' | 'done'

/** 状态 ⇒ 组(手机端用词表):等你决定 ⇒ 等你;在做 ⇒ 在做;这一轮做完了 / 完成 / 没做成 / 停下了 ⇒ 做完。 */
export const GROUP_OF: Record<StatusKey, TogetherGroupKey> = { waiting: 'waiting', working: 'working', replied: 'done', done: 'done', failed: 'done', stopped: 'done' }

/** 「一起做」分三组:等你 / 在做 / 做完,顺序固定;空组不出;组内沿用 togetherView 的顺序(updatedAt 倒序)。
 * 归档的已在 togetherView 里滤掉;终端会话另成一段,不进这三组。 */
export function togetherGroups(rows: TogetherRow[]): Array<{ key: TogetherGroupKey; rows: TogetherRow[] }> {
  const order: TogetherGroupKey[] = ['waiting', 'working', 'done']
  return order.map(key => ({ key, rows: rows.filter(r => GROUP_OF[r.status] === key) })).filter(g => g.rows.length > 0)
}
