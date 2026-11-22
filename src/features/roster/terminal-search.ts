import { basename } from 'node:path'
import type { Db } from '../../lib/db'
import { isScratchMatter, temporary } from '../../lib/topic-provenance'
import { placeKey } from './places-reader'
import { makeProjectRoot, SCRATCH_PREFIX } from './project-root'

export const TERMINAL_SEARCH_SCAN_LIMIT = 20_000
export const TERMINAL_SEARCH_DEFAULT_LIMIT = 20
export const TERMINAL_SEARCH_MAX_LIMIT = 50

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const projectRoot = makeProjectRoot()

/** Offsets are UTF-16 for String.slice. Both edges of the highlight and excerpt are grapheme boundaries. */
function excerpt(text: string, start: number, length: number) {
  let from = 0, to = text.length, first = start, end = start + length
  const offsets: number[] = []
  let following = 0
  for (const { index, segment } of graphemes.segment(text)) {
    const next = index + segment.length
    if (next <= start) { offsets.push(index); continue }
    if (index <= start) {
      first = index
      from = offsets.at(-40) ?? 0
    }
    if (index < start + length) end = next
    else if (++following > 40) { to = index; break }
  }
  const prefix = from > 0 ? '…' : ''
  return { snippet: prefix + text.slice(from, to) + (to < text.length ? '…' : ''), matchStart: prefix.length + first - from, matchLength: end - first }
}

interface Session {
  sessionId: string
  cwd: string
  source: string
  machine: string | null
  origin: string | null
  title: string
  path: string | null
}

export function searchTerminalSpeech(db: Db, owner: string, machine: string, q: string, limit: number, root = projectRoot) {
  const matcher = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu')
  // seq is per matter. The INTEGER PRIMARY KEY gives a global insertion order
  // and lets SQLite walk backwards without scanning or sorting older steps.
  const steps = db.query<{ matter_id: string; kind: string; payload_json: string; created_at: number }, [number]>(
    'SELECT matter_id, kind, payload_json, created_at FROM matter_items ORDER BY id DESC LIMIT ?',
  )
  const session = db.query<Session, [string, string]>(`
    SELECT c.session_id AS sessionId, c.cwd, c.source, c.machine, c.origin_agent AS origin,
           m.title, m.project_path AS path
    FROM matters m JOIN matter_bindings b ON b.matter_id=m.id AND b.surface='cli'
    JOIN cli_sessions c ON c.session_id=b.surface_key
    WHERE m.id=? AND m.kind='terminal' AND m.origin_surface='cli' AND m.initiator='owner'
      AND m.archived_at IS NULL AND (m.owner_chat_id=? OR m.owner_chat_id IS NULL)
    ORDER BY b.last_seen_at DESC, c.session_id LIMIT 1
  `)
  const found = new Map<string, (Pick<Session, 'sessionId' | 'source'> & { placeKey: string; project: string }) | null>()
  const counts = new Map<string, number>()
  const hits = []
  for (const step of steps.iterate(TERMINAL_SEARCH_SCAN_LIMIT)) {
    if (step.kind !== 'user_message' && step.kind !== 'agent_message') continue
    const known = found.get(step.matter_id)
    if (known === null || (known && (counts.get(known.sessionId) ?? 0) >= 3)) continue
    const payload = JSON.parse(step.payload_json) as { text?: unknown; full?: unknown } | null
    const value = typeof payload?.full === 'string' && payload.full ? payload.full : payload?.text
    if (typeof value !== 'string') continue
    const match = matcher.exec(value)
    if (!match) continue

    let details: NonNullable<typeof known> | null | undefined = known
    if (!details) {
      const row = session.get(step.matter_id, owner)
      const path = row && !row.origin && (!row.machine || row.machine === machine) &&
        !isScratchMatter(row.title, row.path) && !temporary(row.cwd) ? root(row.cwd) : null
      details = row && path && !path.startsWith(SCRATCH_PREFIX) && !temporary(path)
        ? { sessionId: row.sessionId, source: row.source, placeKey: placeKey(path), project: basename(path) || path }
        : null
      found.set(step.matter_id, details)
    }
    if (!details) continue
    const count = counts.get(details.sessionId) ?? 0
    if (count >= 3) continue
    counts.set(details.sessionId, count + 1)
    hits.push({ ...details, who: step.kind === 'user_message' ? 'you' as const : 'said' as const, at: step.created_at, ...excerpt(value, match.index, match[0].length) })
    if (hits.length >= limit) break
  }
  return hits
}
