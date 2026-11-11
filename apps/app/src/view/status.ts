// 状态词按手机端用词表(docs/reference/phone-wording.md):在做 / 等你决定 / 这一轮做完了 / 完成 / 没做成 / 停下了。
// interrupted(daemon 重启打断)是「停下了」不是「没做成」:没人说它做错了。
import { STATUS_WORDS, TASK_DETAIL_WORDS, type MatterStateT, type StatusKey } from '@wechat-cc/protocol'
export type { StatusKey }

type TaskObservation = { status: string; phase?: string; networkSuspended?: {since:number} | null }

export function statusOf(task: TaskObservation, pending: number): StatusKey {
  const { status, phase } = task
  if (pending > 0) return 'waiting'
  if (phase === 'failed' || status === 'failed') return 'failed'
  if (status === 'cancelled' || phase === 'cancelled' || status === 'interrupted' || phase === 'interrupted') return 'stopped'
  if (task.networkSuspended && (status === 'running' || status === 'cancelling')) return 'working'
  if (phase === 'replied') return 'replied'
  if (status === 'completed' || phase === 'completed' || phase === 'done') return 'done'
  return 'working'
}

/** 有任务就按任务算;没有任务时退回 matter 自己的状态。 */
export function statusOfMatter(
  matter: { status?: string; state?: MatterStateT; archivedAt?: number | null; kind?: string; taskState?: { status: string; phase?: string } },
  task: { status: string; phase?: string } | null | undefined,
  pending: number,
): StatusKey {
  if (task) return statusOf(task, pending)
  if (pending > 0) return 'waiting'
  if (matter.state !== undefined) {
    if (matter.taskState) return statusOf(matter.taskState, pending)
    if (isMatterArchived(matter)) return 'done'
    if (matter.kind && matter.kind !== 'task') return 'working'
    if (matter.state === 'failed') return 'failed'
    if (matter.state === 'cancelled') return 'stopped'
    return matter.state === 'done' ? 'done' : 'working'
  }
  if (matter.status === 'replied') return 'replied'
  if (matter.status === 'done' || matter.status === 'archived') return 'done'
  return 'working'
}

/** 终端会话的状态并进同一套词(设计稿 2026-10-31 U):等你决定 / 在做 / 歇着 ⇒ 这一轮做完了 / 结束了 ⇒ 完成。 */
export function terminalStatusKey(s: 'waiting' | 'running' | 'idle' | 'ended'): StatusKey {
  return s === 'waiting' ? 'waiting' : s === 'running' ? 'working' : s === 'idle' ? 'replied' : 'done'
}

/** An explicit null is authoritative; only old payloads fall back to status. */
export function isMatterArchived(m: { archivedAt?: number | null; status?: string }): boolean {
  return m.archivedAt === undefined ? m.status === 'archived' : m.archivedAt !== null
}

/** Detail observations share wording with desktop; connectivity has its own UI. */
export function taskDetailLabel(task: TaskObservation | null | undefined, pending: number, lang: 'en' | 'zh-Hans', fallback: StatusKey = 'working'): string {
  const status = task ? statusOf(task, pending) : fallback
  const words = TASK_DETAIL_WORDS[lang]
  if (task && pending === 0) {
    if (task.networkSuspended && (task.status === 'running' || task.status === 'cancelling')) return words.networkPaused
    if (task.phase !== 'replied') {
      if (task.status === 'queued' || task.phase === 'queued') return words.queued
      if (task.status === 'cancelling') return words.cancelling
    }
  }
  return STATUS_WORDS[lang][status]
}
