import type { MatterDetailT, ProgressSummaryT, PhoneChangesTurnT } from '../backend/types'
import { statusOfMatter, type StatusKey } from './status'
import { t, type Lang } from '../i18n'

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
    steps, pendingCount, changedFiles: (changes?.files.length ?? 0) + (changes?.omittedFiles ?? 0),
    summaryState: !t ? 'none' : p ? 'ready' : insight ? 'none' : insightFailed ? 'failed' : 'loading',
  }
}

/** 这件事现在能不能从手机上停(2026-10-06):有一轮在跑(详情带 runId)且还在排队 / 干活;已答复 / 结束的不显示按钮。 */
export function canStop(d: Pick<MatterDetailT, 'runId' | 'task'>): boolean {
  return !!d.runId && (d.task?.phase === 'queued' || d.task?.phase === 'working')
}

/**
 * 改动面板顶上那几句「这一轮查全了没有」(2026-10-20):只审了一部分(读取超时 / 文件太多)、记录不完整、
 * 手机这里放不下的文件,都不能看起来和完整的一轮一样。notes 是电脑那头写的原因(带「只检查了 N / M 个文件」),原样跟在后面。
 * showEmpty:只有查全了的一轮才能说「还没有文件改动」。
 */
export function changesCoverage(turn: PhoneChangesTurnT | null, lang: Lang): { lines: string[]; showEmpty: boolean } {
  if (!turn) return { lines: [], showEmpty: true }
  const lines: string[] = []
  if (turn.status === 'partial') lines.push(t(lang, 'progress.changesPartial'))
  else if (turn.status === 'unavailable') lines.push(t(lang, 'progress.changesUnavailable'))
  if (turn.status !== 'complete') lines.push(...turn.notes)
  if (turn.omittedFiles > 0) lines.push(t(lang, 'progress.changesOmitted', { n: turn.omittedFiles }))
  return { lines, showEmpty: turn.status === 'complete' }
}
