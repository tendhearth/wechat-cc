import type { MatterDetailT, ProgressSummaryT, PhoneChangesTurnT } from '../backend/types'
import { statusOfMatter, type StatusKey } from './status'

export function progressView(detail: MatterDetailT, insight: { progress: ProgressSummaryT | null } | null, changes: PhoneChangesTurnT | null, insightFailed = false): {
  status: StatusKey; title: string; summary: string | null
  steps: Array<{ title: string; detail: string; done: boolean }>; pendingCount: number; changedFiles: number
  /** 概括这一块该怎么显示:没有任务(聊天类)/ 拉到了但没有 ⇒ none,不再永远转骨架屏。 */
  summaryState: 'loading' | 'ready' | 'failed' | 'none'
} {
  const pendingCount = detail.permissions.length + detail.questions.length
  const t = detail.task
  const status = statusOfMatter(detail.matter, t, pendingCount)
  const p = insight?.progress ?? null
  const steps = (p?.steps ?? []).map((s, i, arr) => ({
    title: s.title, detail: s.detail, done: !(status === 'waiting' && i === arr.length - 1),
  }))
  return {
    status, title: t?.title ?? detail.matter.title, summary: p ? p.summary : null,
    steps, pendingCount, changedFiles: changes?.files.length ?? 0,
    summaryState: !t ? 'none' : p ? 'ready' : insight ? 'none' : insightFailed ? 'failed' : 'loading',
  }
}
