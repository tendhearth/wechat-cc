import type { MatterDetailT, ProgressSummaryT, PhoneChangesTurnT } from '../backend/types'
import { statusOf, type StatusKey } from './status'

export function progressView(detail: MatterDetailT, insight: { progress: ProgressSummaryT | null } | null, changes: PhoneChangesTurnT | null): {
  status: StatusKey; title: string; summary: string | null
  steps: Array<{ title: string; detail: string; done: boolean }>; pendingCount: number; changedFiles: number
} {
  const pendingCount = detail.permissions.length + detail.questions.length
  const t = detail.task
  const status = t
    ? statusOf(t, pendingCount)
    : pendingCount > 0 ? 'waiting'
    : detail.matter.status === 'replied' ? 'replied'
    : detail.matter.status === 'done' || detail.matter.status === 'archived' ? 'done' : 'working'
  const p = insight?.progress ?? null
  const steps = (p?.steps ?? []).map((s, i, arr) => ({
    title: s.title, detail: s.detail, done: !(status === 'waiting' && i === arr.length - 1),
  }))
  return {
    status, title: t?.title ?? detail.matter.title, summary: p ? p.summary : null,
    steps, pendingCount, changedFiles: changes?.files.length ?? 0,
  }
}
