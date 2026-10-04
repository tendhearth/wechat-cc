import type { Backend, MatterInputT } from '../backend/types'
import type { PairingRecord } from '../net/pairing'
import { uuid } from '../net/uuid'
import { deleteDraft, getDraft, getDraftStamp, sameDraftStamp, pairingGen, type DraftStamp } from './drafts'
import { InputJournalError, inputPairingScope, inputPayload, type InputJournal, type StoredInput } from './input-journal'

export type InputStatus = MatterInputT['status'] | 'submitting' | 'accepted' | 'uncertain' | 'failed' | 'refused'
export type InputSnapshot = Readonly<StoredInput>
export type InputRecovery = Readonly<{ phase: 'loading' | 'ready' | 'error'; scope: string | null; error?: string }>
const EMPTY: readonly InputSnapshot[] = []
const terminal = (r: InputSnapshot) => r.status === 'delivered' || r.status === 'withdrawn'
export const inputNeedsChecking = (r: InputSnapshot) => !terminal(r)
export function matchesMatterInput(snapshot: InputSnapshot, input: MatterInputT): boolean {
  return snapshot.taskId === input.taskId && snapshot.requestId === input.id && snapshot.text === input.text && (snapshot.runId === undefined || snapshot.runId === input.runId)
}
const safeError = (e: unknown) => e instanceof InputJournalError ? e.code : 'input_storage'

/** A fresh instance restores from SecureStore, not from a previous screen/module's memory. */
export function makeMatterInputState(deps: { journal?: InputJournal; getDraft?: typeof getDraft; getDraftStamp?: typeof getDraftStamp; deleteDraft?: typeof deleteDraft; mk?: () => string } = {}) {
  let journal = deps.journal
  let gen = 0, scope: string | null = null
  let rows: readonly InputSnapshot[] = EMPTY
  let recovery: InputRecovery = { phase: journal ? 'loading' : 'ready', scope: null }
  let queue: Promise<unknown> = Promise.resolve()
  let needsLoad = !!journal
  let pendingClear = false
  let checking: { at: number; promise: Promise<void> } | null = null
  let liveExpected = false
  const stamp = (id: string): DraftStamp | undefined => deps.getDraftStamp ? deps.getDraftStamp(id) : deps.getDraft ? undefined : getDraftStamp(id)
  const bindDraft = (id: string, raw: string) => {
    const s = (deps.getDraft ?? getDraft)(id) === raw ? stamp(id) : undefined
    return s ? { draftOwner: s.owner, draftRevision: s.revision } : {}
  }
  const listeners = new Set<() => void>()
  const taskCache = new Map<string, readonly InputSnapshot[]>()
  const notify = () => { taskCache.clear(); for (const l of [...listeners]) l() }
  const phase = (next: InputRecovery) => { recovery = next; notify() }
  const set = (next: readonly InputSnapshot[]) => { rows = next; notify() }
  const enqueue = <T,>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn); queue = next.catch(() => {}); return next
  }
  const valid = (at: number) => at === gen
  async function persist(next: readonly InputSnapshot[], at: number) {
    if (!valid(at)) throw new InputJournalError('input_scope')
    if (journal && scope) await journal.write(scope, next, () => valid(at))
    if (!valid(at)) throw new InputJournalError('input_scope')
  }
  function fail(e: unknown, at: number) {
    if (valid(at) && !['input_capacity', 'input_scope'].includes(safeError(e))) phase({ phase: 'error', scope, error: safeError(e) })
  }
  function begin(taskId: string, rawText: string, runId?: string, mk = deps.mk ?? uuid): InputSnapshot {
    const text = rawText.trim()
    const prior = rows.findLast(r => r.taskId === taskId && r.text === text && ['submitting', 'uncertain', 'failed'].includes(r.status))
    if (prior) return prior
    const next: InputSnapshot = { taskId, requestId: mk(), ...(runId !== undefined ? { runId } : {}), text, rawText, status: 'submitting', ...bindDraft(taskId, rawText) }
    set([...rows, next]); return next
  }
  async function update(snapshot: InputSnapshot, patch: { status: InputStatus; error?: string; draftHandled?: boolean }, at = gen) {
    if (!valid(at)) return
    const original = rows.find(r => r.taskId === snapshot.taskId && r.requestId === snapshot.requestId)
    if (!original || terminal(original) && !terminal({ ...original, ...patch })) return
    if (original.status === patch.status && original.error === patch.error && (patch.draftHandled === undefined || original.draftHandled === patch.draftHandled)) return
    const next = rows.map(r => r === original ? { ...r, ...patch, error: patch.error } : r)
    set(next)
    try { await enqueue(() => persist(next, at)) } catch (e) { fail(e, at); throw e }
  }
  async function applyReceipts(inputs: readonly MatterInputT[], at: number, expected?: ReadonlySet<InputSnapshot>) {
    if (!valid(at)) return
    let changed = false
    const next = rows.map(original => {
      // An exact GET can arrive after a newer observed receipt. Only unchanged rows
      // may accept that read; the next sweep can verify a held row again.
      if (expected && !expected.has(original)) return original
      const found = inputs.find(input => input.id === original.requestId && input.taskId === original.taskId)
      if (!found || terminal(original)) return original
      const patch = matchesMatterInput(original, found) ? { status: found.status, error: found.error && /^[a-z0-9_]{1,64}$/.test(found.error) ? found.error : undefined }
        : { status: 'refused' as const, error: 'input_conflict' }
      if (original.status === patch.status && original.error === patch.error) return original
      changed = true; return { ...original, ...patch }
    })
    if (!changed) return
    set(next)
    try { await enqueue(() => persist(next, at)) } catch (e) { fail(e, at); throw e }
  }
  return {
    subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l) } },
    recovery: () => recovery,
    all: () => rows,
    generation: () => gen,
    durable: () => !!journal,
    suspend() { gen++; phase({ phase: 'loading', scope }) },
    rows(taskId: string): readonly InputSnapshot[] {
      if (!taskCache.has(taskId)) taskCache.set(taskId, rows.filter(r => r.taskId === taskId))
      return taskCache.get(taskId)!
    },
    configure(j?: InputJournal) { journal = j; needsLoad = !!j; phase({ phase: j ? 'loading' : 'ready', scope }) },
    /** Credential transitions invalidate in-flight reads/writes synchronously, before any await. */
    activate(pairing: PairingRecord | null, restore = true) {
      const at = ++gen; liveExpected = pairing !== null; scope = null; needsLoad = true; pendingClear = false; set(EMPTY); phase({ phase: 'loading', scope: null })
      return enqueue(async () => {
        try {
          if (!valid(at)) throw new InputJournalError('input_scope')
          const key = pairing && journal ? await inputPairingScope(pairing, journal.hash) : null
          if (!valid(at)) throw new InputJournalError('input_scope')
          scope = key
          if (journal) {
            if (!pairing || !restore) await journal.clear(() => valid(at))
            if (key && restore) {
              const saved = await journal.load(key, () => valid(at))
              if (!valid(at)) throw new InputJournalError('input_scope')
              const recovered = saved.map(r => r.status === 'submitting' ? { ...r, status: 'uncertain' as const } : r)
              set(recovered); await persist(recovered, at)
            }
          }
          if (!valid(at)) throw new InputJournalError('input_scope')
          needsLoad = false; phase({ phase: 'ready', scope })
        } catch (e) { fail(e, at); throw new InputJournalError(safeError(e) as 'input_storage' | 'input_recovery' | 'input_scope') }
      })
    },
    /** Tombstone commits erasure before chunk deletion. Leftovers cannot be restored. */
    clear() {
      const at = ++gen; liveExpected = false; scope = null; needsLoad = false; pendingClear = true; set(EMPTY); phase({ phase: 'loading', scope: null })
      return enqueue(async () => {
        try { if (journal) await journal.clear(() => valid(at)); if (valid(at)) { pendingClear = false; phase({ phase: 'ready', scope: null }) } }
        catch (e) { fail(e, at); throw e }
      })
    },
    begin,
    /** Only a successful durable prepare can authorize a POST. Failure keeps the original. */
    async prepare(taskId: string, rawText: string, runId?: string, retry?: InputSnapshot, forLive = false) {
      if (recovery.phase !== 'ready') throw new InputJournalError('input_recovery')
      if (forLive && (!journal || !scope || !liveExpected) || journal && liveExpected && !scope) throw new InputJournalError('input_scope')
      const at = gen
      let snapshot: InputSnapshot
      if (retry) {
        const known = rows.find(r => r.taskId === retry.taskId && r.requestId === retry.requestId)
        if (!known || known.taskId !== taskId || !['uncertain', 'failed'].includes(known.status)) throw new InputJournalError('input_scope')
        snapshot = known
      } else {
        snapshot = rows.findLast(r => r.taskId === taskId && r.text === rawText.trim() && ['uncertain', 'failed'].includes(r.status))
          ?? { taskId, requestId: (deps.mk ?? uuid)(), ...(runId !== undefined ? { runId } : {}), text: rawText.trim(), rawText, status: 'submitting', ...bindDraft(taskId, rawText) }
      }
      let next: readonly InputSnapshot[] = rows.some(r => r === snapshot) ? rows.map(r => r === snapshot ? { ...r, status: 'submitting' as const, error: undefined } : r) : [...rows, snapshot]
      try {
        for (;;) {
          try { inputPayload(next); break } catch (e) {
            // Never evict an unconfirmed original. Only handled, confirmed records may make room.
            const removable = next.find(r => terminal(r) && r.draftHandled)
            if (!removable) throw e
            next = next.filter(r => r !== removable)
          }
        }
        set(next)
        await enqueue(() => persist(next, at))
        if (!valid(at) || recovery.phase !== 'ready') throw new InputJournalError('input_scope')
        const latest = rows.find(r => r.taskId === snapshot.taskId && r.requestId === snapshot.requestId)
        if (!latest || latest.status !== 'submitting') throw new InputJournalError('input_scope')
        return latest
      } catch (e) {
        if (valid(at)) {
          set(rows.map(r => r.taskId === snapshot.taskId && r.requestId === snapshot.requestId && r.status === 'submitting' ? { ...r, status: 'failed', error: safeError(e) } : r))
          fail(e, at)
        }
        throw e
      }
    },
    update,
    async observe(taskId: string, inputs: readonly MatterInputT[], at = gen) {
      await applyReceipts(inputs.filter(r => r.taskId === taskId), at)
    },
    async consume(taskId: string) {
      const at = gen; let cleared = false
      for (const captured of rows.filter(r => r.taskId === taskId)) {
        if (!valid(at)) return cleared
        const snapshot = rows.find(r => r.taskId === taskId && r.requestId === captured.requestId)
        if (!snapshot) continue
        if (snapshot.draftHandled || !['accepted', 'pending', 'sending', 'delivered'].includes(snapshot.status)) continue
        const submittedStamp = snapshot.draftOwner !== undefined && snapshot.draftRevision !== undefined ? { owner: snapshot.draftOwner, revision: snapshot.draftRevision } : undefined
        const before = stamp(taskId)
        const ownsDraft = before && sameDraftStamp(submittedStamp, before) && (deps.getDraft ?? getDraft)(taskId) === snapshot.rawText
        await update(snapshot, { status: snapshot.status, draftHandled: true }, at)
        const latest = rows.find(r => r.taskId === snapshot.taskId && r.requestId === snapshot.requestId)
        const after = stamp(taskId)
        if (valid(at) && ownsDraft && after && sameDraftStamp(submittedStamp, after) && latest && latest.runId === snapshot.runId && latest.text === snapshot.text && latest.rawText === snapshot.rawText && ['accepted', 'pending', 'sending', 'delivered'].includes(latest.status) && (deps.getDraft ?? getDraft)(taskId) === snapshot.rawText) {
          (deps.deleteDraft ?? deleteDraft)(taskId); cleared = true
        }
      }
      return cleared
    },
    async retryStorage(pairing: PairingRecord | null) {
      if (pendingClear) return this.clear()
      if (needsLoad) return this.activate(pairing)
      const at = gen
      try { await enqueue(() => persist(rows, at)); if (valid(at)) phase({ phase: 'ready', scope }) }
      catch (e) { fail(e, at); throw e }
    },
    /** Even if detail is truncated/413, independently query retained ids. Never POST on recovery. */
    async reconcile(backend: Pick<Backend, 'matterInputReceipt'>, taskId?: string) {
      const at = gen
      if (recovery.phase !== 'ready') return
      if (checking?.at === at) return checking.promise
      // A single sweep covers every retained task, including archived ones; screens share it.
      const sweep = async () => {
        const foundInputs: MatterInputT[] = []
        const checkingRows = rows.filter(inputNeedsChecking)
        const expected = new Set(checkingRows)
        for (const snapshot of checkingRows) {
          if (!valid(at)) return
          try {
            const found = await backend.matterInputReceipt(snapshot.taskId, snapshot.requestId)
            if (!valid(at)) return
            // Null / old-server 404 / unsupported never proves non-delivery.
            if (found) foundInputs.push(found)
          } catch { /* Keep uncertainty; session handles revoked credentials. */ }
        }
        try { await applyReceipts(foundInputs, at, expected) } catch { /* Recovery notice locks further sends. */ }
      }
      const promise = sweep(); checking = { at, promise }
      try { await promise } finally { if (checking?.promise === promise) checking = null }
    },
    async settled() { await queue },
  }
}

export const matterInputState = makeMatterInputState()
let legacyGeneration = pairingGen()
const current = () => {
  if (legacyGeneration !== pairingGen()) { legacyGeneration = pairingGen(); if (!matterInputState.durable()) void matterInputState.clear().catch(() => {}) }
}
export const subscribeMatterInputs = matterInputState.subscribe
export const matterInputs = (id: string) => { current(); return matterInputState.rows(id) }
export const allMatterInputs = matterInputState.all
export const matterInputRecovery = matterInputState.recovery
export const beginMatterInput = (id: string, text: string, runId?: string, mk?: () => string) => { current(); return matterInputState.begin(id, text, runId, mk) }
export const updateMatterInput = (row: InputSnapshot, patch: { status: InputStatus; error?: string; draftHandled?: boolean }, atGen = pairingGen(), journalGen = matterInputState.generation()) => {
  if (atGen !== pairingGen()) return Promise.resolve()
  return matterInputState.update(row, patch, journalGen)
}
export const observeMatterInputs = (id: string, inputs: readonly MatterInputT[]) => matterInputState.observe(id, inputs)
export const consumeMatterInputDraft = matterInputState.consume
