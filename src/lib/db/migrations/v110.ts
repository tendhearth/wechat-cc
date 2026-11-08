import type { Migration } from './types'

// S4 operations: append-only picker observations; no message content.
export const migration: Migration = db => {
  db.exec(`CREATE TABLE IF NOT EXISTS speech_audit_events (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    source TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    ref TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK(outcome IN ('allowed','blocked','deferred')),
    reason TEXT
  ) STRICT;
  CREATE INDEX IF NOT EXISTS speech_audit_events_at ON speech_audit_events(at);
  CREATE TABLE IF NOT EXISTS speech_audit_coverage (
    id INTEGER PRIMARY KEY CHECK(id=1), started_at INTEGER NOT NULL
  ) STRICT;`)
}
