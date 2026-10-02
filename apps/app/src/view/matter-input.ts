import type { MatterDetailT, MatterInputT } from '../backend/types'
import { t, type Lang } from '../i18n'
import { matchesMatterInput, type InputSnapshot, type InputStatus } from '../state/matter-inputs'

export function inputStatusText(status: InputStatus, lang: Lang, error?: string): string {
  if (status === 'refused' && error === 'input_stale') return t(lang, 'input.stale')
  if (status === 'refused' && error === 'input_conflict') return t(lang, 'input.conflict')
  return t(lang, `input.${status}`)
}
export const inputCanRetry = (snapshot: InputSnapshot) => ['uncertain', 'failed'].includes(snapshot.status)
export const inputAccepted = (status: InputStatus) => ['accepted', 'pending', 'sending', 'delivered'].includes(status)
export function inputFailure(error: string): { status: InputStatus; error: string } {
  return { status: ['uncertain', 'timeout', 'unknown'].includes(error) ? 'uncertain' : ['offline', 'unavailable'].includes(error) ? 'failed' : 'refused', error }
}

/** 远端回执作准;本机仅补入尚未查到的快照,并保留用户最初的换行和空白。 */
export function inputRows(remote: readonly MatterInputT[], local: readonly InputSnapshot[]): InputSnapshot[] {
  const rows = remote.map(input => {
    const original = local.find(row => row.requestId === input.id && row.taskId === input.taskId)
    if (original && !matchesMatterInput(original, input)) return { ...original, status: 'refused' as const, error: 'input_conflict' }
    return { taskId: input.taskId, requestId: input.id, runId: input.runId, text: input.text, rawText: original?.rawText ?? input.text, status: input.status } as InputSnapshot
  })
  for (const snapshot of local) if (!rows.some(row => row.requestId === snapshot.requestId)) rows.push(snapshot)
  return rows
}

export function matterInputHint(detail: MatterDetailT | undefined, lang: Lang): string | null {
  if (detail?.matter.kind !== 'task') return null
  return detail.inputMode === 'queue' ? t(lang, 'input.queueHint') : detail.inputMode === 'steer' ? t(lang, 'input.steerHint') : null
}
