/**
 * session-store.ts — persistent (alias, provider, chat_id) → session_id map for SDK resume.
 *
 * Daemon restarts drop the in-memory session pool; the first message per
 * alias cold-starts a fresh Claude Agent SDK session (~10s per Spike 1
 * data). This store remembers the last session_id per alias so spawn()
 * can call query({ resume: session_id }) and cut that to <3s.
 *
 * Backed by the daemon's SQLite db (PR7 — moved off
 * ~/.claude/channels/wechat/sessions.json). Triple-keyed by (alias,
 * provider, chat_id) as of v0.6 (Task 7 migration v10), so two chats
 * pointing at the same project alias keep distinct SDK sessions —
 * essential for the 3-tier permissions work where each chat carries its
 * own tier and must not share a resume point.
 *
 * Provider tagging (RFC 03 P0): each row carries the provider that
 * created the session. session_id strings are NOT interchangeable
 * between `claude` and `codex` (Claude jsonl path vs Codex
 * `~/.codex/sessions/`), so passing the wrong one to spawn() fails the
 * resume. Records read from the legacy JSON without a provider field
 * are migrated as `provider='claude'` (matches the v0.x default), and
 * any legacy migration path lands rows under `chat_id='_legacy'`.
 */
import { existsSync } from 'node:fs'
import { renameMigrated, type Db } from '../../lib/db'
import { readJsonFile } from '../../lib/read-json-file'

import type { ProviderId } from '../../domain/conversation'
import type { SessionRecord, SessionStore } from '../../ports/session-store'

/** v0.x default — JSON records without `provider` belong to this. */
const LEGACY_PROVIDER: ProviderId = 'claude'
/** v0.5→v0.6 default — JSON records have no chat_id field. */
const LEGACY_CHAT_ID = '_legacy'

export interface SessionStoreOpts {
  /**
   * Path to the legacy sessions.json. When set + the file exists, its
   * contents are imported into the SQLite table on construction and
   * the file is renamed to `<path>.migrated`.
   */
  migrateFromFile?: string
}

interface LegacyShape {
  version?: 1
  sessions?: Record<string, {
    session_id: string
    last_used_at: string
    provider?: ProviderId
    summary?: string
    summary_updated_at?: string
  }>
}

interface Row {
  alias: string
  provider: string
  chat_id: string
  session_id: string
  last_used_at: string
  summary: string | null
  summary_updated_at: string | null
}

function rowToRecord(r: Row): SessionRecord {
  return {
    alias: r.alias,
    session_id: r.session_id,
    last_used_at: r.last_used_at,
    provider: r.provider,
    chat_id: r.chat_id,
    ...(r.summary !== null ? { summary: r.summary } : {}),
    ...(r.summary_updated_at !== null ? { summary_updated_at: r.summary_updated_at } : {}),
  }
}

function compositeKey(alias: string, provider: string, chatId: string): string {
  return `${alias}|${provider}|${chatId}`
}

export function makeSessionStore(db: Db, opts: SessionStoreOpts = {}): SessionStore {
  if (opts.migrateFromFile) maybeImportLegacy(db, opts.migrateFromFile)

  const stmtGet = db.query<Row, [string, string, string]>(
    'SELECT alias, provider, chat_id, session_id, last_used_at, summary, summary_updated_at ' +
    'FROM sessions WHERE alias = ? AND provider = ? AND chat_id = ?',
  )
  const stmtUpsert = db.query<unknown, [string, string, string, string, string]>(
    'INSERT INTO sessions(alias, provider, chat_id, session_id, last_used_at) VALUES (?, ?, ?, ?, ?) ' +
    'ON CONFLICT(alias, provider, chat_id) DO UPDATE SET session_id = excluded.session_id, last_used_at = excluded.last_used_at',
  )
  const stmtBumpTs = db.query<unknown, [string, string, string, string]>(
    'UPDATE sessions SET last_used_at = ? WHERE alias = ? AND provider = ? AND chat_id = ?',
  )
  const stmtSetSummary = db.query<unknown, [string, string, string, string, string]>(
    'UPDATE sessions SET summary = ?, summary_updated_at = ? WHERE alias = ? AND provider = ? AND chat_id = ?',
  )
  const stmtDeleteAliasChat = db.query<unknown, [string, string]>(
    'DELETE FROM sessions WHERE alias = ? AND chat_id = ?',
  )
  const stmtDeleteOne = db.query<unknown, [string, string, string]>(
    'DELETE FROM sessions WHERE alias = ? AND provider = ? AND chat_id = ?',
  )
  const stmtCountProvider = db.query<{ n: number }, [string]>(
    'SELECT COUNT(*) AS n FROM sessions WHERE provider = ?',
  )
  const stmtDeleteProvider = db.query<unknown, [string]>(
    'DELETE FROM sessions WHERE provider = ?',
  )
  const stmtCountProviderChat = db.query<{ n: number }, [string, string]>(
    'SELECT COUNT(*) AS n FROM sessions WHERE provider = ? AND chat_id = ?',
  )
  const stmtDeleteProviderChat = db.query<unknown, [string, string]>(
    'DELETE FROM sessions WHERE provider = ? AND chat_id = ?',
  )
  const stmtAll = db.query<Row, []>(
    'SELECT alias, provider, chat_id, session_id, last_used_at, summary, summary_updated_at ' +
    'FROM sessions ORDER BY alias, provider, chat_id, last_used_at DESC, rowid DESC',
  )

  return {
    get({ alias, provider, chatId }) {
      const row = stmtGet.get(alias, provider, chatId)
      return row ? rowToRecord(row) : null
    },

    set({ alias, provider, chatId, sessionId }) {
      const now = new Date().toISOString()
      const existing = stmtGet.get(alias, provider, chatId)
      if (existing && existing.session_id === sessionId) {
        // Same session_id under same triple — just bump timestamp.
        stmtBumpTs.run(now, alias, provider, chatId)
      } else {
        stmtUpsert.run(alias, provider, chatId, sessionId, now)
      }
    },

    setSummary({ alias, provider, chatId }, summary) {
      const target = stmtGet.get(alias, provider, chatId)
      if (!target) return
      const now = new Date().toISOString()
      stmtSetSummary.run(summary, now, alias, provider, chatId)
    },

    delete({ alias, chatId }) {
      // Remove ALL provider rows for this (alias, chatId) — `delete` is
      // intended as "forget this chat's binding to this project entirely".
      stmtDeleteAliasChat.run(alias, chatId)
    },

    deleteOne({ alias, provider, chatId }) {
      stmtDeleteOne.run(alias, provider, chatId)
    },

    deleteProvider(provider) {
      // Count first: the DELETE statement's own change count isn't exposed
      // uniformly across the sqlite bindings this repo runs on (bun:sqlite vs
      // node:sqlite), and a wrong number here would be a lie in the read-back.
      const n = stmtCountProvider.get(provider)?.n ?? 0
      if (n > 0) stmtDeleteProvider.run(provider)
      return n
    },

    deleteProviderChat(provider, chatId) {
      // Same count-then-delete shape as deleteProvider, for the same reason:
      // the DELETE statement's own change count isn't exposed uniformly
      // across the sqlite bindings this repo runs on.
      const n = stmtCountProviderChat.get(provider, chatId)?.n ?? 0
      if (n > 0) stmtDeleteProviderChat.run(provider, chatId)
      return n
    },

    all() {
      // Returns Record<`${alias}|${provider}|${chatId}`, SessionRecord>.
      // Keys must be unique; the SQL PK guarantees that.
      const out: Record<string, SessionRecord> = {}
      for (const r of stmtAll.all()) {
        out[compositeKey(r.alias, r.provider, r.chat_id)] = rowToRecord(r)
      }
      return out
    },

    async flush() { /* SQLite writes are immediate */ },
  }
}

function maybeImportLegacy(db: Db, file: string): void {
  if (!existsSync(file)) return
  let parsed: LegacyShape | null = null
  try {
    parsed = readJsonFile(file) as LegacyShape
  } catch {
    // Corrupt JSON — preserve the original on disk for forensic debugging.
    return
  }
  const sessions = parsed?.sessions
  if (sessions && typeof sessions === 'object') {
    // Legacy JSON has no chat_id; everything lands under '_legacy'. The v10
    // migration's 1-day TTL sweep handles cleanup if these rows go stale.
    const insert = db.prepare(
      'INSERT OR REPLACE INTO sessions(alias, provider, chat_id, session_id, last_used_at, summary, summary_updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    db.transaction(() => {
      for (const [alias, rec] of Object.entries(sessions)) {
        if (!rec || typeof rec.session_id !== 'string' || typeof rec.last_used_at !== 'string') continue
        insert.run(
          alias,
          rec.provider ?? LEGACY_PROVIDER,
          LEGACY_CHAT_ID,
          rec.session_id,
          rec.last_used_at,
          rec.summary ?? null,
          rec.summary_updated_at ?? null,
        )
      }
    })()
  }
  renameMigrated(file)
}
