// 状态词按手机端用词表(docs/reference/phone-wording.md):在做 / 等你决定 / 这一轮做完了 / 完成 / 没做成 / 停下了。
// interrupted(daemon 重启打断)是「停下了」不是「没做成」:没人说它做错了。
export type StatusKey = 'working' | 'waiting' | 'replied' | 'done' | 'failed' | 'stopped'

export function statusOf(task: { status: string; phase?: string }, pending: number): StatusKey {
  const { status, phase } = task
  if (pending > 0) return 'waiting'
  if (phase === 'failed' || status === 'failed') return 'failed'
  if (status === 'cancelled' || phase === 'cancelled' || status === 'interrupted' || phase === 'interrupted') return 'stopped'
  if (phase === 'replied') return 'replied'
  if (status === 'completed' || phase === 'completed' || phase === 'done') return 'done'
  return 'working'
}

/** 有任务就按任务算;没有任务时退回 matter 自己的状态。 */
export function statusOfMatter(
  matter: { status: string },
  task: { status: string; phase?: string } | null | undefined,
  pending: number,
): StatusKey {
  if (task) return statusOf(task, pending)
  if (pending > 0) return 'waiting'
  if (matter.status === 'replied') return 'replied'
  if (matter.status === 'done' || matter.status === 'archived') return 'done'
  return 'working'
}
