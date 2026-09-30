export type StatusKey = 'working' | 'waiting' | 'replied' | 'done' | 'failed' | 'stopped'

export function statusOf(task: { status: string; phase?: string }, pending: number): StatusKey {
  const { status, phase } = task
  if (pending > 0) return 'waiting'
  if (phase === 'failed' || phase === 'interrupted' || status === 'failed' || status === 'interrupted') return 'failed'
  if (status === 'cancelled' || phase === 'cancelled') return 'stopped'
  if (phase === 'replied') return 'replied'
  if (status === 'completed' || phase === 'completed' || phase === 'done') return 'done'
  return 'working'
}
