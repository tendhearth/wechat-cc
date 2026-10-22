import type { Migration } from './types'

// v1 — session_state. PR7 commit 1.
export const migration: Migration = (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_state (
        bot_id TEXT PRIMARY KEY NOT NULL,
        first_seen_expired_at TEXT NOT NULL,
        last_reason TEXT
      ) STRICT;
    `)
  }
