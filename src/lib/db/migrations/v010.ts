import type { Migration } from './types'

// v10 — per-chat session keys. Pre-tier sessions get chat_id='_legacy'
// and are cleaned up if they're older than a day (most installs have
// nothing newer; the 1-day grace handles fresh upgrades mid-conversation).
// See docs/superpowers/specs/2026-05-22-user-tier-permissions-design.md.
export const migration: Migration = (db) => {
    // SQLite can't ALTER a PRIMARY KEY in place; rebuild the table.
    // The column add + table rebuild + delete happen inside this migration
    // function which runs in a single transaction in the runner.
    db.exec(`
      ALTER TABLE sessions ADD COLUMN chat_id TEXT NOT NULL DEFAULT '_legacy';
      CREATE TABLE sessions_v10 (
        alias TEXT NOT NULL,
        provider TEXT NOT NULL,
        -- DEFAULT '_legacy' keeps callers that don't yet supply chat_id from
        -- failing on INSERT. Task 8 rewrites session-store queries to always
        -- pass an explicit chat_id; the default becomes vestigial then, but
        -- harmless. Removing it later requires another migration.
        chat_id TEXT NOT NULL DEFAULT '_legacy',
        session_id TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        summary TEXT,
        summary_updated_at TEXT,
        PRIMARY KEY (alias, provider, chat_id)
      ) STRICT;
      INSERT INTO sessions_v10(alias, provider, chat_id, session_id, last_used_at, summary, summary_updated_at)
        SELECT alias, provider, chat_id, session_id, last_used_at, summary, summary_updated_at FROM sessions;
      DROP TABLE sessions;
      ALTER TABLE sessions_v10 RENAME TO sessions;
      CREATE INDEX IF NOT EXISTS sessions_alias_last_used ON sessions(alias, last_used_at DESC);
    `)
    // Cleanup pre-tier rows older than 1 day. ISO 8601 string-comparable.
    const cutoff = new Date(Date.now() - 86_400_000).toISOString()
    db.exec(`DELETE FROM sessions WHERE chat_id = '_legacy' AND last_used_at < '${cutoff}'`)
  }
