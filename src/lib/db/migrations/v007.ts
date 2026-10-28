import type { Migration } from './types'

// v7 — events (per-chat append-only decision log). PR7 commit 7.
// The largest table by volume; introspect cron writes ~1 row per
// tick × per chat × per day. Index on (chat_id, ts DESC) is what the
// dashboard's "last N decisions" query hits.
export const migration: Migration = (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY NOT NULL,
        chat_id TEXT NOT NULL,
        ts TEXT NOT NULL,
        kind TEXT NOT NULL,
        trigger TEXT NOT NULL,
        reasoning TEXT NOT NULL,
        push_text TEXT,
        observation_id TEXT,
        milestone_id TEXT,
        jsonl_session_id TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS events_chat_ts ON events(chat_id, ts DESC);
    `)
  }
