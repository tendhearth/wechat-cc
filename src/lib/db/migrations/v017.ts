import type { Migration } from './types'

// v17 — message_attempts: per-message processing-attempt counter, so a
// "poison" message (one whose turn persistently throws) can't reprocess
// forever across daemon restarts. mw-dedup increments this BEFORE running the
// pipeline; after N attempts it gives up (marks the message handled) instead
// of re-running. Separate from handled_messages because the row must exist
// BEFORE the message is handled (handled_messages rows only appear on
// success). Same id scheme as handled_messages / the messages table.
export const migration: Migration = (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS message_attempts (
        id         TEXT PRIMARY KEY NOT NULL,
        attempts   INTEGER NOT NULL,
        first_seen TEXT NOT NULL
      ) STRICT;
    `)
  }
