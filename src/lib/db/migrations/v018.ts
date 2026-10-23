import type { Migration } from './types'

// v18 — connection_heartbeat: records the timestamp of each successful
// ilink getUpdates poll per account. Keyed by account.id (the directory
// id, same key used for session_state and expiredBots). Used by the
// doctor report (heartbeats field) and the dashboard "上次活动" display.
export const migration: Migration = (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS connection_heartbeat (
        account_id TEXT PRIMARY KEY NOT NULL,
        last_update_ok_at TEXT NOT NULL
      ) STRICT;
    `)
  }
