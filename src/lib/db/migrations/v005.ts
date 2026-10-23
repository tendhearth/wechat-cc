import type { Migration } from './types'

// v5 — milestones (per-chat fires, id-deduped, permanent). PR7 commit 5.
// event_id back-pointer mirrors the existing JSONL field; it's nullable
// because demo seeding writes milestones without an associated event.
export const migration: Migration = (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS milestones (
        chat_id TEXT NOT NULL,
        id TEXT NOT NULL,
        ts TEXT NOT NULL,
        body TEXT NOT NULL,
        event_id TEXT,
        PRIMARY KEY (chat_id, id)
      ) STRICT;
    `)
  }
