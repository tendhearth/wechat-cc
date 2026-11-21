import { PlaceMapBranch, type PlaceMapItemT, type PlaceOutlineRunResponseT, type PlaceOutlineSourceT, type PlaceOutlineT } from '@wechat-cc/protocol'
import z from 'zod'
import type { Db } from '../../lib/db'
import type { CheapEval } from '../../ports/agent-provider'
import { outlineHash, outlineSourcesAllowed, type OutlineInput, type OutlineLocation, type OutlineRef } from './place-outline-input'

const output = z.object({ aspects: z.array(z.object({
  name: z.string(),
  items: z.array(z.object({ line: z.string(), status: PlaceMapBranch, refs: z.array(z.string()) })),
})) })
type Aspect = NonNullable<PlaceOutlineT['aspects']>[number]
type StoredAspect = Omit<Aspect, 'items'> & { items: (Omit<Aspect['items'][number], 'sources'> & { sources: OutlineRef[] })[] }
type PinnedMatter = { id: string; matterId: string }
type Snapshot = {
  owner: string; location: OutlineLocation; input: OutlineInput; items: PlaceMapItemT[]
  pinnedEntries: string[]; pinnedMatters: PinnedMatter[]
}
type Stored = { owner: string; aspects: StoredAspect[]; refs: OutlineRef[]; pinnedMatters: PinnedMatter[] }
type ErrorCode = NonNullable<PlaceOutlineT['error']>
type State = Exclude<PlaceOutlineT['state'], 'none'>
type Row = { state: State; fingerprint: string; result_json: string; error: ErrorCode | ''; call_day: string; finished_ts: string }
export type OutlineStart = PlaceOutlineRunResponseT | 'outline_quota' | 'lab_off' | 'place_not_found' | 'unavailable'

const short = (s: string, limit: number) => [...s.trim().replace(/\s+/g, ' ')].slice(0, limit).join('')
export function parseOutline(text: string, refs: Map<string, OutlineRef>): StoredAspect[] | null {
  if (!text.trim()) return []
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first < 0 || last < first) return null
  let raw: unknown
  try { raw = JSON.parse(text.slice(first, last + 1)) } catch { return null }
  const parsed = output.safeParse(raw)
  if (!parsed.success) return null
  const result: StoredAspect[] = []
  let count = 0
  for (const aspect of parsed.data.aspects) {
    const name = short(aspect.name, 8)
    if (!name) continue
    const items: StoredAspect['items'] = []
    for (const item of aspect.items) {
      const line = short(item.line, 40)
      if (!line || item.refs.length < 1 || item.refs.length > 3 || item.refs.some(ref => !refs.has(ref))) continue
      items.push({ id: `o:${count++}`, line, status: item.status, sources: [...new Set(item.refs)].map(ref => refs.get(ref)!) })
      if (items.length === 8 || count === 40) break
    }
    if (items.length) result.push({ name, items })
    if (result.length === 7 || count === 40) break
  }
  return result
}

export interface PlaceOutlineDeps {
  evaluator: () => CheapEval | null
  holdBusy?: (label: string) => () => void
  log?: (tag: string, line: string, fields?: Record<string, unknown>) => void
}

export function makePlaceOutlines(deps: PlaceOutlineDeps & {
  db: Db
  now: () => number
  enabled: () => boolean
  owner: () => string | null
  load: (key: string) => Promise<Snapshot | null>
}) {
  const { db, now } = deps
  const day = () => {
    const local = new Date(now())
    const padded = (value: number) => String(value).padStart(2, '0')
    return `${local.getFullYear()}-${padded(local.getMonth() + 1)}-${padded(local.getDate())}`
  }
  const iso = () => new Date(now()).toISOString()
  db.query("UPDATE place_outlines SET state='failed',error='interrupted',finished_ts=? WHERE state='running'").run(iso())
  const get = db.query<Row, [string]>('SELECT * FROM place_outlines WHERE place_key=?')
  const begin = db.query(`
    INSERT INTO place_outlines (place_key,state,fingerprint,started_ts) VALUES (?,'running',?,?)
    ON CONFLICT(place_key) DO UPDATE SET state='running',fingerprint=excluded.fingerprint,
      result_json='', error='', started_ts=excluded.started_ts, finished_ts=''
  `)
  const charge = db.query("UPDATE place_outlines SET call_day=? WHERE place_key=? AND state='running'")
  const finish = db.query("UPDATE place_outlines SET state=?,result_json=?,error=?,finished_ts=? WHERE place_key=? AND state='running'")
  let epoch = 0

  async function run(key: string, snapshot: Snapshot, startedEpoch: number) {
    const { owner, input, items, location, pinnedEntries, pinnedMatters } = snapshot
    const refs: OutlineRef[] = [...input.refs.values(), ...pinnedEntries.map(entryId => ({ kind: 'entry' as const, entryId }))]
    const start = now()
    let release: (() => void) | undefined
    let state: State = 'failed'
    let error: ErrorCode | '' = 'unavailable'
    let result = ''
    let sent = false
    const valid = () => epoch === startedEpoch && deps.enabled() && deps.owner() === owner
    try {
      release = deps.holdBusy?.('place-outline')
      const evaluate = deps.evaluator()
      if (!evaluate) {
        error = 'no_private_model'
        return
      }
      // Admission can await network checks. Revalidate the toggle and identity at dispatch.
      const response = await evaluate(input.prompt, { singleAttempt: true, beforeRequest() {
        if (!valid() || !outlineSourcesAllowed(db, owner, refs, items, location, pinnedMatters)) {
          error = 'stale'
          throw Error('stale')
        }
        if (sent) throw Error('outline_quota')
        charge.run(day(), key)
        sent = true
      } })
      if (!sent) return
      const aspects = parseOutline(response, input.refs)
      const current = valid() ? await deps.load(key) : null
      if (!valid() || current?.input.fingerprint !== input.fingerprint) {
        error = 'stale'
      } else if (!aspects) {
        error = 'bad_output'
      } else {
        state = aspects.length >= 3 ? 'ready' : 'empty'
        error = ''
        // Keep the provenance of the entire batch for later authorization checks.
        if (state === 'ready') result = JSON.stringify({ owner: outlineHash(owner), aspects, refs, pinnedMatters } satisfies Stored)
      }
    } catch {
      if (!valid()) error = 'stale'
    } finally {
      try {
        finish.run(state, result, error, iso(), key)
        deps.log?.('PLACE_OUTLINE', 'finished', { key, ...input.counts, elapsedMs: now() - start, state, error })
      } finally { release?.() }
    }
  }

  return {
    invalidate() { epoch++ },
    async start(key: string): Promise<OutlineStart> {
      if (!deps.enabled()) return 'lab_off'
      if (!deps.owner()) return 'unavailable'
      if (get.get(key)?.state === 'running') return { ok: true, state: 'running' }
      const currentEpoch = epoch
      const snapshot = await deps.load(key)
      if (!deps.enabled() || epoch !== currentEpoch) return 'lab_off'
      if (!snapshot) return 'place_not_found'
      if (deps.owner() !== snapshot.owner) return 'unavailable'
      const row = get.get(key)
      if (row?.state === 'running') return { ok: true, state: 'running' }
      if ((row?.state === 'ready' || row?.state === 'empty') && row.fingerprint === snapshot.input.fingerprint) {
        return { ok: true, state: row.state, unchanged: true }
      }
      if (row?.call_day === day()) return 'outline_quota'
      begin.run(key, snapshot.input.fingerprint, iso())
      void run(key, snapshot, currentEpoch).catch(() => deps.log?.('PLACE_OUTLINE', 'unavailable', { key }))
      return { ok: true, state: 'running' }
    },
    read(key: string, snapshot: Snapshot | null): PlaceOutlineT {
      const row = get.get(key)
      const canRun = row?.call_day !== day()
      if (!row || !snapshot) return { state: 'none', canRun }
      const stale = row.fingerprint !== snapshot.input.fingerprint
      const at = row.finished_ts ? Date.parse(row.finished_ts) : undefined
      if (row.state !== 'ready') {
        const error = row.error === 'no_private_model' && deps.evaluator() ? 'unavailable' : row.error || undefined
        return { state: row.state, canRun, stale, at, error }
      }
      const stored = JSON.parse(row.result_json) as Stored
      if (stored.owner !== outlineHash(snapshot.owner) || !outlineSourcesAllowed(db, snapshot.owner, stored.refs, snapshot.items, snapshot.location, stored.pinnedMatters)) {
        return { state: 'failed', error: 'stale', canRun, stale: true, at }
      }
      const publicSource = (source: OutlineRef): PlaceOutlineSourceT => source.kind === 'entry' ? { kind: 'entry' }
        : { kind: 'session', matterId: source.matterId, sessionId: source.sessionId, agent: source.agent, at: source.at }
      const aspects = stored.aspects.map(aspect => ({
        name: aspect.name,
        items: aspect.items.map(item => ({ ...item, sources: item.sources.map(publicSource) })),
      }))
      return { state: 'ready', at, canRun, stale, aspects }
    },
  }
}
