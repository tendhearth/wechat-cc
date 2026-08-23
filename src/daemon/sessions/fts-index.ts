/**
 * Cross-session FTS index (db.ts v30) — the "SQLite FTS upgrade tracked for
 * v0.5" from searcher.ts. One FTS5 trigram row per session-jsonl line;
 * refresh is incremental via a per-file (lines_indexed, byte_size) watermark
 * in session_fts_state:
 *
 *  - file grew        → index only the new lines (append-only jsonl is the
 *                       normal case, so refresh cost is O(new lines))
 *  - file shrank      → the transcript was rewritten; drop that file's rows
 *                       and reindex from scratch (rowids are not stable
 *                       across rewrites, so patching in place would lie)
 *  - file missing     → skip; rows/state stay for when it comes back (the
 *                       searcher re-reads the line at hit time and drops
 *                       hits whose file/line vanished, so stale rows are
 *                       harmless)
 *
 * Stored text is capped at FTS_LINE_MAX chars per line — search targets
 * conversational content, not megabyte tool dumps, and the searcher re-reads
 * the raw line from disk for snippets anyway.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import type { Db } from '../../lib/db'

export const FTS_LINE_MAX = 2000

export interface SessionFileRef {
  alias: string
  session_id: string
  path: string
}

export interface FtsSessionHit {
  alias: string
  session_id: string
  turn_index: number
}

export function refreshSessionFtsIndex(db: Db, sessions: SessionFileRef[]): void {
  const getState = db.query<{ lines_indexed: number; byte_size: number }, [string]>(
    'SELECT lines_indexed, byte_size FROM session_fts_state WHERE path = ?',
  )
  const putState = db.query<unknown, [string, string, string, number, number]>(
    `INSERT INTO session_fts_state(path, alias, session_id, lines_indexed, byte_size)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET alias = excluded.alias, session_id = excluded.session_id,
       lines_indexed = excluded.lines_indexed, byte_size = excluded.byte_size`,
  )
  const insertRow = db.query<unknown, [string, string, string, number]>(
    'INSERT INTO session_turns_fts(text, alias, session_id, turn_index) VALUES (?, ?, ?, ?)',
  )
  const deleteRows = db.query<unknown, [string]>('DELETE FROM session_turns_fts WHERE session_id = ?')
  const deleteState = db.query<unknown, [string]>('DELETE FROM session_fts_state WHERE path = ?')

  for (const s of sessions) {
    if (!existsSync(s.path)) continue
    let size: number
    try {
      size = statSync(s.path).size
    } catch {
      continue
    }
    const state = getState.get(s.path)
    if (state && size === state.byte_size) continue          // unchanged — cheapest exit
    let from = state?.lines_indexed ?? 0
    if (state && size < state.byte_size) {
      // Rewritten/truncated — line indexes are no longer trustworthy.
      deleteRows.run(s.session_id)
      deleteState.run(s.path)
      from = 0
    }
    let lines: string[]
    try {
      lines = readFileSync(s.path, 'utf8').split('\n').filter(l => l.length > 0)
    } catch {
      continue
    }
    if (lines.length > from) {
      db.exec('BEGIN')
      try {
        for (let i = from; i < lines.length; i++) {
          insertRow.run(lines[i]!.slice(0, FTS_LINE_MAX), s.alias, s.session_id, i)
        }
        putState.run(s.path, s.alias, s.session_id, lines.length, size)
        db.exec('COMMIT')
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
    } else {
      // Grew only in whitespace/partial-line bytes — just advance byte_size.
      putState.run(s.path, s.alias, s.session_id, lines.length, size)
    }
  }
}

export function ftsSearchSessions(db: Db, query: string, limit: number): FtsSessionHit[] {
  const q = (query ?? '').trim()
  if (!q) return []
  // Wrap as a single FTS5 phrase literal so punctuation / operator words
  // (AND, -, ", *, :, ...) match literally instead of raising a MATCH syntax
  // error — same posture as knowledge/store.ts's keywordSearch.
  const fq = '"' + q.replace(/"/g, '""') + '"'
  return db.query<FtsSessionHit, [string, number]>(
    `SELECT alias, session_id, turn_index FROM session_turns_fts
     WHERE session_turns_fts MATCH ? ORDER BY bm25(session_turns_fts) LIMIT ?`,
  ).all(fq, limit)
}
