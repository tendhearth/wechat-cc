import type { ApprovalItemT, AgentsTopicT, ChatPageT, MatterT } from '../backend/types'
import { markdownPlainText } from '@wechat-cc/markdown'
import { statusOfMatter, type StatusKey } from './status'

export function matterStatus(m: MatterT, agents: AgentsTopicT, pending: number): StatusKey {
  const t = agents.tasks.find(x => x.id === m.id)
  return statusOfMatter(m, t ? { status: 'running', phase: t.phase } : null, pending)
}

export type WaitingRow = { taskId: string; kind: 'permission' | 'question'; firstRequestId: string; count: number; fallback: string; matterTitle: string }

/** 「此刻」只回答一个问题:现在有什么要我管的(spec 2026-10-01 §5.2)。一起做的列表不在这里重复。
 * known=false(够不着电脑,等你的事读不到/是旧的)⇒ 不显示旧行,waitingUnknown 让页面说「暂时不知道有没有等你的事」(终审 M3)。 */
export function nowView(input: { approvals: ApprovalItemT[]; matters: MatterT[]; hour: number; known?: boolean }): {
  greetingKey: 'now.greetingMorning' | 'now.greetingAfternoon' | 'now.greetingEvening'
  waiting: WaitingRow[]
  waitingUnknown: boolean
} {
  const { approvals, matters, hour } = input
  const known = input.known ?? true
  const greetingKey = hour >= 5 && hour <= 11 ? 'now.greetingMorning' : hour >= 12 && hour <= 17 ? 'now.greetingAfternoon' : 'now.greetingEvening'
  const rows = new Map<string, WaitingRow>()
  for (const x of approvals) {
    const r = rows.get(x.taskId)
    if (r) { r.count++; if (x.kind === 'permission') r.kind = 'permission'; continue }
    rows.set(x.taskId, { taskId: x.taskId, kind: x.kind, firstRequestId: x.id, count: 1, fallback: x.summary, matterTitle: matters.find(m => m.id === x.taskId)?.title ?? '' })
  }
  return known ? { greetingKey, waiting: [...rows.values()], waitingUnknown: false } : { greetingKey, waiting: [], waitingUnknown: true }
}

/** CC 气泡:主人那条对话里最近一条 CC 说的话。没有就是 null —— 不画空气泡、不编客套话。 */
export function latestCCLine(page: ChatPageT | undefined): { text: string; at: number } | null {
  if (!page) return null
  for (let i = page.messages.length - 1; i >= 0; i--) {
    const m = page.messages[i]!
    if (m.role === 'cc') {
      const text = markdownPlainText(m.text).trim()
      if (text !== '') return { text, at: m.at }
    }
  }
  return null
}
