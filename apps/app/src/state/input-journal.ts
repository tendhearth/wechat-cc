import z from 'zod'
import type { SecureStoreLike } from '../net/credentials'
import type { PairingRecord } from '../net/pairing'

export const INPUT_JOURNAL_KEY = 'tendhearth.matter-inputs.v1'
export const INPUT_JOURNAL_MAX_ROWS = 64
export const INPUT_JOURNAL_MAX_BYTES = 512 * 1024
export const INPUT_JOURNAL_CHUNK_BYTES = 1800
export const INPUT_JOURNAL_MAX_CHUNKS = Math.ceil(INPUT_JOURNAL_MAX_BYTES / INPUT_JOURNAL_CHUNK_BYTES)
export const InputSnapshotSchema = z.object({
  taskId: z.string().min(1).max(256), requestId: z.string().min(1).max(256), runId: z.string().min(1).max(256).optional(),
  text: z.string().min(1).max(20_000), rawText: z.string().max(40_000),
  status: z.enum(['pending', 'sending', 'delivered', 'held', 'withdrawn', 'submitting', 'accepted', 'uncertain', 'failed', 'refused']),
  error: z.string().max(64).optional(), draftHandled: z.boolean().optional(),
})
export type StoredInput = z.infer<typeof InputSnapshotSchema>
const Payload = z.object({ v: z.literal(1), rows: z.array(InputSnapshotSchema).max(INPUT_JOURNAL_MAX_ROWS) })
const INDEX_MAX_BYTES = 32 * 1024
const INDEX_MAX_CHUNKS = Math.ceil(INDEX_MAX_BYTES / (INPUT_JOURNAL_CHUNK_BYTES - 3))
const BODY_MAX_BYTES = 256 * 1024
const BODY_MAX_CHUNKS = Math.ceil(BODY_MAX_BYTES / (INPUT_JOURNAL_CHUNK_BYTES - 3))
const Body = InputSnapshotSchema.pick({ taskId: true, requestId: true, runId: true, text: true, rawText: true })
const Ref = z.object({ slot: z.number().int().min(0).max(INPUT_JOURNAL_MAX_ROWS - 1), bank: z.union([z.literal(0), z.literal(1)]),
  chunks: z.number().int().min(1).max(BODY_MAX_CHUNKS), bytes: z.number().int().min(1).max(BODY_MAX_BYTES), sha256: z.string().regex(/^[a-f0-9]{64}$/) })
const IndexRow = Ref.extend({ status: InputSnapshotSchema.shape.status, error: InputSnapshotSchema.shape.error, draftHandled: InputSnapshotSchema.shape.draftHandled })
const Index = z.object({ v: z.literal(1), rows: z.array(IndexRow).max(INPUT_JOURNAL_MAX_ROWS) })
const Pointer = z.discriminatedUnion('state', [
  z.object({ v: z.literal(1), state: z.literal('empty') }),
  z.object({ v: z.literal(1), state: z.literal('committed'), scope: z.string().regex(/^[a-f0-9]{64}$/), bank: z.union([z.literal(0), z.literal(1)]),
    chunks: z.number().int().min(1).max(INDEX_MAX_CHUNKS), bytes: z.number().int().min(1).max(INDEX_MAX_BYTES), sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
])
type Commit = Extract<z.infer<typeof Pointer>, { state: 'committed' }>
type BodyRef = z.infer<typeof Ref>
export class InputJournalError extends Error {
  constructor(public code: 'input_storage' | 'input_capacity' | 'input_recovery' | 'input_scope') { super(code) }
}
export type Hash = (text: string) => Promise<string>
/** Complete credential identity; no plaintext credential is persisted or used as a key. */
export const inputPairingScope = (p: PairingRecord, hash: Hash) => hash(JSON.stringify(['tendhearth/input/v1', p.relayHost, p.relayUrl, p.daemonId, p.deviceId, p.deviceToken]))
const bytes = (s: string) => new TextEncoder().encode(s).length
const bodyKey = (slot: number, bank: number) => `${INPUT_JOURNAL_KEY}.body.${slot}.${bank}`
const indexKey = (bank: number) => `${INPUT_JOURNAL_KEY}.index.${bank}`
const rowKey = (r: Pick<StoredInput, 'taskId' | 'requestId'>) => JSON.stringify([r.taskId, r.requestId])
const refKey = (r: BodyRef) => bodyKey(r.slot, r.bank)
function split(s: string): string[] {
  const chunks: string[] = []; let part = '', size = 0
  for (const cp of s) {
    const n = bytes(cp)
    if (size + n > INPUT_JOURNAL_CHUNK_BYTES) { chunks.push(part); part = ''; size = 0 }
    part += cp; size += n
  }
  if (part) chunks.push(part)
  return chunks
}
export function inputPayload(rows: readonly StoredInput[]): string {
  const checked = Payload.safeParse({ v: 1, rows })
  if (!checked.success) throw new InputJournalError('input_capacity')
  const raw = JSON.stringify(checked.data)
  if (bytes(raw) > INPUT_JOURNAL_MAX_BYTES) throw new InputJournalError('input_capacity')
  return raw
}
export interface InputJournal {
  hash: Hash
  load(scope: string, current: () => boolean): Promise<StoredInput[]>
  write(scope: string, rows: readonly StoredInput[], current: () => boolean): Promise<void>
  clear(current: () => boolean): Promise<void>
}
/**
 * Immutable per-row original + small versioned status index. Updating a receipt never rewrites
 * its 20k body. Commit pointer is written last; incomplete chunks/index are never accepted.
 * Fixed slots/banks and prewritten chunk-count headers bound and expose crash orphans for cleanup.
 */
export function makeInputJournal(ss: SecureStoreLike, hash: Hash, opts: Record<string, unknown> = {}): InputJournal {
  let committed: Commit | null = null
  let refs = new Map<string, BodyRef>()
  let bodies = new Map<string, string>()
  let needsCleanup = false
  const counts = new Map<string, number>()
  const check = (current: () => boolean) => { if (!current()) throw new InputJournalError('input_scope') }
  async function count(key: string, max: number, current: () => boolean) {
    if (counts.has(key)) return counts.get(key)!
    const raw = await ss.getItemAsync(`${key}.count`, opts); check(current)
    if (raw === null) { counts.set(key, 0); return 0 }
    const n = Number(raw)
    if (!Number.isInteger(n) || n < 0 || n > max) throw new InputJournalError('input_recovery')
    counts.set(key, n); return n
  }
  async function erase(key: string, max: number, current: () => boolean) {
    const n = await count(key, max, current)
    if (n === 0) return
    let failed = false
    for (let i = 0; i < n; i++) {
      check(current)
      try { await ss.deleteItemAsync(`${key}.${i}`, opts) } catch { failed = true }
    }
    if (failed) throw new InputJournalError('input_storage')
    check(current); await ss.deleteItemAsync(`${key}.count`, opts); check(current); counts.set(key, 0)
  }
  async function cleanup(keep: Set<string>, current: () => boolean, indices = false) {
    let error: unknown
    const keys: string[] = []
    for (let slot = 0; slot < INPUT_JOURNAL_MAX_ROWS; slot++) for (let bank = 0; bank < 2; bank++) if (!keep.has(bodyKey(slot, bank))) keys.push(bodyKey(slot, bank))
    for (let start = 0; start < keys.length; start += 8) {
      const results = await Promise.allSettled(keys.slice(start, start + 8).map(key => erase(key, BODY_MAX_CHUNKS, current)))
      check(current)
      for (const r of results) if (r.status === 'rejected') error = r.reason
    }
    if (indices) for (let bank = 0; bank < 2; bank++) try { await erase(indexKey(bank), INDEX_MAX_CHUNKS, current) } catch (e) { check(current); error = e }
    if (error) throw error
  }
  async function writeChunks(key: string, text: string, max: number, current: () => boolean) {
    const parts = split(text)
    if (parts.length > max) throw new InputJournalError('input_capacity')
    const previous = await count(key, max, current)
    // Count before chunks: after a crash, even an uncommitted body can be completely erased.
    check(current); await ss.setItemAsync(`${key}.count`, String(Math.max(previous, parts.length)), opts); check(current)
    counts.set(key, Math.max(previous, parts.length))
    for (let i = 0; i < parts.length; i++) { check(current); await ss.setItemAsync(`${key}.${i}`, parts[i]!, opts); check(current) }
    return parts.length
  }
  async function readChunks(key: string, chunks: number, size: number, sha: string, maxBytes: number, current: () => boolean) {
    let text = ''
    for (let i = 0; i < chunks; i++) {
      const chunk = await ss.getItemAsync(`${key}.${i}`, opts); check(current)
      if (chunk === null || bytes(chunk) > INPUT_JOURNAL_CHUNK_BYTES) throw new InputJournalError('input_recovery')
      text += chunk
      if (bytes(text) > maxBytes) throw new InputJournalError('input_recovery')
    }
    if (bytes(text) !== size || await hash(text) !== sha) throw new InputJournalError('input_recovery')
    check(current); return text
  }
  async function tombstone(current: () => boolean) {
    check(current); await ss.setItemAsync(INPUT_JOURNAL_KEY, JSON.stringify({ v: 1, state: 'empty' }), opts); check(current)
    committed = null; refs = new Map(); bodies = new Map()
  }
  return {
    hash,
    async load(scope, current) {
      check(current)
      const raw = await ss.getItemAsync(INPUT_JOURNAL_KEY, opts); check(current)
      let p: z.infer<typeof Pointer> | null = null
      if (raw !== null) try { p = Pointer.parse(JSON.parse(raw)) } catch { throw new InputJournalError('input_recovery') }
      if (!p || p.state === 'empty' || p.scope !== scope) {
        if (p?.state === 'committed') await tombstone(current)
        committed = null; refs = new Map(); bodies = new Map(); await cleanup(new Set(), current, true); return []
      }
      const text = await readChunks(indexKey(p.bank), p.chunks, p.bytes, p.sha256, INDEX_MAX_BYTES, current)
      let entries: z.infer<typeof IndexRow>[]
      try {
        entries = Index.parse(JSON.parse(text)).rows
        if (new Set(entries.map(r => r.slot)).size !== entries.length || entries.reduce((n, r) => n + r.bytes, 0) > INPUT_JOURNAL_MAX_BYTES) throw new Error()
      } catch { throw new InputJournalError('input_recovery') }
      const restored: StoredInput[] = [], nextRefs = new Map<string, BodyRef>(), nextBodies = new Map<string, string>()
      for (const entry of entries) {
        const bodyText = await readChunks(refKey(entry), entry.chunks, entry.bytes, entry.sha256, BODY_MAX_BYTES, current)
        let body: z.infer<typeof Body>
        try { body = Body.parse(JSON.parse(bodyText)); if (body.text !== body.rawText.trim()) throw new Error() } catch { throw new InputJournalError('input_recovery') }
        if (nextRefs.has(rowKey(body))) throw new InputJournalError('input_recovery')
        nextRefs.set(rowKey(body), Ref.parse(entry))
        nextBodies.set(rowKey(body), JSON.stringify(body))
        restored.push({ ...body, status: entry.status, ...(entry.error !== undefined ? { error: entry.error } : {}), ...(entry.draftHandled !== undefined ? { draftHandled: entry.draftHandled } : {}) })
      }
      inputPayload(restored); check(current)
      committed = p; refs = nextRefs; bodies = nextBodies
      await cleanup(new Set([...refs.values()].map(refKey)), current)
      return restored
    },
    async write(scope, rows, current) {
      check(current); inputPayload(rows)
      if (needsCleanup || rows.some(row => !refs.has(rowKey(row)))) {
        const keep = new Set([...refs.values()].map(refKey))
        // A failed attempt's chunks are exposed by their prewritten headers. Erase them before
        // allocating a new original so repeated failures cannot accumulate stale body bytes.
        for (const [key, n] of counts) if (n && key.includes('.body.') && !keep.has(key)) await erase(key, BODY_MAX_CHUNKS, current)
        needsCleanup = false
      }
      const nextRefs = new Map<string, BodyRef>(), nextBodies = new Map<string, string>(), entries: z.infer<typeof IndexRow>[] = []
      const occupied = new Set([...refs.values()].map(r => r.slot))
      for (const row of rows) {
        const body = JSON.stringify(Body.parse(row)); check(current)
        let ref = refs.get(rowKey(row))
        if (ref && bodies.get(rowKey(row)) !== body) throw new InputJournalError('input_scope')
        if (!ref) {
          const sha256 = await hash(body); check(current)
          let slot = 0
          while (occupied.has(slot) && slot < INPUT_JOURNAL_MAX_ROWS) slot++
          if (slot >= INPUT_JOURNAL_MAX_ROWS) {
            const reusable = [...refs.entries()].find(([key, old]) => !rows.some(r => rowKey(r) === key) && !entries.some(r => r.slot === old.slot))
            if (!reusable) throw new InputJournalError('input_capacity')
            slot = reusable[1].slot
            ref = { ...reusable[1], bank: reusable[1].bank === 0 ? 1 : 0 }
          }
          occupied.add(slot)
          const bank = ref?.bank ?? 0
          const chunks = await writeChunks(bodyKey(slot, bank), body, BODY_MAX_CHUNKS, current)
          ref = { slot, bank, chunks, bytes: bytes(body), sha256 }
        }
        nextRefs.set(rowKey(row), ref)
        nextBodies.set(rowKey(row), body)
        entries.push({ ...ref, status: row.status, ...(row.error !== undefined ? { error: row.error } : {}), ...(row.draftHandled !== undefined ? { draftHandled: row.draftHandled } : {}) })
      }
      const index = JSON.stringify({ v: 1, rows: entries }), bank = committed?.bank === 0 ? 1 : 0
      if (bytes(index) > INDEX_MAX_BYTES) throw new InputJournalError('input_capacity')
      const chunks = await writeChunks(indexKey(bank), index, INDEX_MAX_CHUNKS, current)
      const pointer: Commit = { v: 1, state: 'committed', scope, bank, chunks, bytes: bytes(index), sha256: await hash(index) }
      check(current); await ss.setItemAsync(INPUT_JOURNAL_KEY, JSON.stringify(pointer), opts); check(current)
      const oldRefs = refs; committed = pointer; refs = nextRefs; bodies = nextBodies
      // Only removed originals need cleanup here; ordinary receipt updates do no body I/O.
      const keep = new Set([...refs.values()].map(refKey))
      for (const old of oldRefs.values()) if (!keep.has(refKey(old))) {
        try { await erase(refKey(old), BODY_MAX_CHUNKS, current) } catch (e) { needsCleanup = true; throw e }
      }
    },
    async clear(current) { await tombstone(current); await cleanup(new Set(), current, true) },
  }
}
