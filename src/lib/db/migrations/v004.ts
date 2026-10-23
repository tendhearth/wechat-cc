import type { Migration } from './types'

// v4 — activity (per-chat per-day inbound message tally). PR7 commit 4.
// One row per (chat_id, UTC date). Detector reads recent days to
// evaluate the 7-day-streak milestone.
export const migration: Migration = (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS activity (
        chat_id TEXT NOT NULL,
        date TEXT NOT NULL,            -- YYYY-MM-DD UTC
        first_msg_ts TEXT NOT NULL,    -- ISO 8601
        msg_count INTEGER NOT NULL,
        PRIMARY KEY (chat_id, date)
      ) STRICT;
    `)
  }
