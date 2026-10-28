import type { Migration } from './types'

// v16 — handled_messages: dedup marker for inbound message processing.
// One row per inbound message that has been FULLY processed (a reply was
// sent, or it was consumed as a command) — written only after the pipeline
// settles without throwing. On macOS sleep/wake the long-poll cursor can
// regress (daemon restart / lock-steal loads a not-yet-persisted sync_buf),
// making the ilink server redeliver already-answered messages. The mw-dedup
// middleware consults this table to skip re-running the agent on a redelivery
// while still re-processing messages whose first turn crashed before replying
// (those never got marked here). Keyed by the same id as the messages table
// (`userId:createTimeMs`, or a content hash when create_time_ms is absent).
export const migration: Migration = (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS handled_messages (
        id         TEXT PRIMARY KEY NOT NULL,
        handled_at TEXT NOT NULL
      ) STRICT;
    `)
  }
