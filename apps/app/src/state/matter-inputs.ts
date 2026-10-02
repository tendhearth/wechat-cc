import type { MatterInputT } from '../backend/types'
import { uuid } from '../net/uuid'
import { deleteDraft, getDraft, pairingGen } from './drafts'

export type InputStatus = MatterInputT['status'] | 'submitting' | 'accepted' | 'uncertain' | 'failed' | 'refused'
export type InputSnapshot = Readonly<{
  taskId: string; requestId: string; runId?: string; text: string; rawText: string; status: InputStatus; error?: string; draftHandled?: boolean
}>
const EMPTY: readonly InputSnapshot[] = []
let generation = pairingGen()
const byTask = new Map<string, readonly InputSnapshot[]>()
const listeners = new Set<() => void>()
const notify = () => { for (const listener of [...listeners]) listener() }
const current = () => {
  if (generation !== pairingGen()) { byTask.clear(); generation = pairingGen() }
}
export const subscribeMatterInputs = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
export const matterInputs = (taskId: string): readonly InputSnapshot[] => generation === pairingGen() ? byTask.get(taskId) ?? EMPTY : EMPTY

/** 同一条未确认补充重发时,沿用第一次的 runId / requestId / 正文,不会绑到后来的一轮。 */
export function beginMatterInput(taskId: string, rawText: string, runId?: string, mk: () => string = uuid): InputSnapshot {
  current()
  const text = rawText.trim()
  const rows = byTask.get(taskId) ?? EMPTY
  const prior = [...rows].reverse().find(row => row.text === text && ['submitting', 'uncertain', 'failed', 'refused'].includes(row.status))
  if (prior) return prior
  const next: InputSnapshot = { taskId, requestId: mk(), ...(runId ? { runId } : {}), text, rawText, status: 'submitting' }
  byTask.set(taskId, [...rows, next]); notify()
  return next
}

export function updateMatterInput(snapshot: InputSnapshot, update: Pick<InputSnapshot, 'status'> & { error?: string; draftHandled?: boolean }, atGen = pairingGen()): void {
  if (atGen !== pairingGen()) return
  current()
  const rows = byTask.get(snapshot.taskId)
  if (!rows) return
  let changed = false
  const next = rows.map(row => {
    if (row.requestId !== snapshot.requestId || row.status === update.status && row.error === update.error && (update.draftHandled === undefined || row.draftHandled === update.draftHandled)) return row
    changed = true
    return { ...row, ...update, error: update.error }
  })
  if (changed) { byTask.set(snapshot.taskId, next); notify() }
}

export function matchesMatterInput(snapshot: InputSnapshot, input: MatterInputT): boolean {
  return snapshot.taskId === input.taskId && snapshot.requestId === input.id && snapshot.text === input.text && (!snapshot.runId || snapshot.runId === input.runId)
}

/** 查询与重连只核对已有回执,从不自动重发。 */
export function observeMatterInputs(taskId: string, inputs: readonly MatterInputT[]): void {
  for (const snapshot of matterInputs(taskId)) {
    const found = inputs.find(input => input.id === snapshot.requestId && input.taskId === taskId)
    if (found) updateMatterInput(snapshot, matchesMatterInput(snapshot, found) ? { status: found.status } : { status: 'refused', error: 'input_conflict' })
  }
}

/** 只处理一次已受理回执;发送途中写的新草稿、后来取回的原文都不能被清掉。 */
export function consumeMatterInputDraft(taskId: string): boolean {
  let cleared = false
  for (const snapshot of matterInputs(taskId)) {
    if (snapshot.draftHandled || !['accepted', 'pending', 'sending', 'delivered'].includes(snapshot.status)) continue
    if (getDraft(taskId) === snapshot.rawText) { deleteDraft(taskId); cleared = true }
    updateMatterInput(snapshot, { status: snapshot.status, draftHandled: true })
  }
  return cleared
}
