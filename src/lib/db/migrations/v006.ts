import type { Migration } from './types'

// v6 — observations (per-chat companion notes, archive flag). PR7 commit 6.
// archived is INTEGER (0/1) per SQLite STRICT — no native bool type.
export const migration: Migration = (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS observations (
        id TEXT PRIMARY KEY NOT NULL,
        chat_id TEXT NOT NULL,
        ts TEXT NOT NULL,
        body TEXT NOT NULL,
        tone TEXT,
        archived INTEGER NOT NULL DEFAULT 0,
        archived_at TEXT,
        event_id TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS observations_chat_ts ON observations(chat_id, ts DESC);
    `)
  }
