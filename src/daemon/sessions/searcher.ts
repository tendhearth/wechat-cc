/**
 * Cross-session full-text search.
 *
 * v0.5 FTS upgrade (2026-08-23-memory-upgrades): queries of ≥3 chars run
 * against the incrementally-maintained FTS5 trigram index (fts-index.ts,
 * db.ts v30) — refresh cost is O(new lines) on append-only jsonl, query cost
 * is an index lookup instead of reading every transcript. Snippets and turn
 * JSON are still produced by re-reading the matched line from the file, so
 * the SearchHit shape is unchanged and a hit whose transcript vanished is
 * silently dropped.
 *
 * Queries under 3 chars (the trigram tokenizer's minimum — think 2-char CJK
 * words like 上海) fall back to the original case-insensitive substring scan.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeSessionStore } from '../../core/session-store'
import type { Db } from '../../lib/db'
import { resolveProjectJsonlPath } from './path-resolver'
import { refreshSessionFtsIndex, ftsSearchSessions, type SessionFileRef } from './fts-index'

export interface SearchHit {
  alias: string
  session_id: string
  turn_index: number
  snippet: string                  // ~140 chars around raw-line match (detailed mode)
  turn: unknown                    // parsed JSON for the matched line, or null on parse failure
  session_has_reply_tool: boolean  // computed once per session — gates compact-mode wrap-up suppression
}

// Cheap string check — the tool name is always quoted in the JSON
// serialization, so substring search beats parsing every line just to
// detect this flag.
const REPLY_TOOL_MARKER = '"mcp__wechat__reply"'

function toHit(line: string, needle: string, alias: string, sessionId: string, turnIndex: number, sessionHasReplyTool: boolean): SearchHit {
  const idx = line.toLowerCase().indexOf(needle)
  const at = idx < 0 ? 0 : idx                       // FTS matched inside the stored prefix; anchor at 0 if the raw scan misses
  const start = Math.max(0, at - 60)
  const end = Math.min(line.length, at + needle.length + 60)
  let parsed: unknown = null
  try { parsed = JSON.parse(line) } catch { /* leave null — client treats as un-projectable */ }
  return {
    alias,
    session_id: sessionId,
    turn_index: turnIndex,
    snippet: line.slice(start, end),
    turn: parsed,
    session_has_reply_tool: sessionHasReplyTool,
  }
}

export async function searchAcrossSessions(
  query: string,
  opts: { limit?: number; stateDir: string; home?: string; db: Db },
): Promise<SearchHit[]> {
  const limit = opts.limit ?? 50
  if (!query || query.trim().length === 0) return []

  const store = makeSessionStore(opts.db, { migrateFromFile: join(opts.stateDir, 'sessions.json') })
  const all = store.all()
  const needle = query.toLowerCase()

  // v0.6 Task 8: all() keys are `${alias}|${provider}|${chatId}` strings —
  // read alias off the record. Multiple rows can share an alias (one per
  // provider × chat); each jsonl gets searched independently.
  const refs: SessionFileRef[] = []
  const seenPaths = new Set<string>()
  for (const rec of Object.values(all)) {
    const path = resolveProjectJsonlPath(rec.alias, rec.session_id, opts.home ? { home: opts.home } : {})
    if (seenPaths.has(path)) continue
    seenPaths.add(path)
    refs.push({ alias: rec.alias, session_id: rec.session_id, path })
  }

  // Trigram needs ≥3 chars; shorter queries keep the substring scan.
  if ([...query.trim()].length < 3) return scanSessions(refs, needle, limit)

  refreshSessionFtsIndex(opts.db, refs)
  const ftsHits = ftsSearchSessions(opts.db, query.trim(), limit)
  const pathBySession = new Map(refs.map(r => [r.session_id, r.path]))
  // Per-session line cache so N hits in one transcript read the file once.
  const fileCache = new Map<string, { lines: string[]; hasReplyTool: boolean }>()
  const hits: SearchHit[] = []
  for (const h of ftsHits) {
    const path = pathBySession.get(h.session_id)
    if (!path || !existsSync(path)) continue          // transcript gone — index row is stale, drop the hit
    let cached = fileCache.get(path)
    if (!cached) {
      const lines = readFileSync(path, 'utf8').split('\n').filter(l => l.length > 0)
      cached = { lines, hasReplyTool: lines.some(l => l.includes(REPLY_TOOL_MARKER)) }
      fileCache.set(path, cached)
    }
    const line = cached.lines[h.turn_index]
    if (line === undefined) continue                  // file shrank since refresh — stale row
    hits.push(toHit(line, needle, h.alias, h.session_id, h.turn_index, cached.hasReplyTool))
    if (hits.length >= limit) break
  }
  return hits
}

/** The original naive scan — now the sub-3-char fallback path. */
function scanSessions(refs: SessionFileRef[], needle: string, limit: number): SearchHit[] {
  const hits: SearchHit[] = []
  for (const ref of refs) {
    if (!existsSync(ref.path)) continue
    const lines = readFileSync(ref.path, 'utf8').split('\n').filter(l => l.length > 0)
    const sessionHasReplyTool = lines.some(l => l.includes(REPLY_TOOL_MARKER))
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      if (!line.toLowerCase().includes(needle)) continue
      hits.push(toHit(line, needle, ref.alias, ref.session_id, i, sessionHasReplyTool))
      if (hits.length >= limit) return hits
    }
  }
  return hits
}
