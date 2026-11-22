import type { Migration } from './types'

// v122 — private terminal recaps and their per-session model budget.
export const migration: Migration = db => {
  db.exec(`CREATE TABLE IF NOT EXISTS terminal_recaps (
    session_id TEXT PRIMARY KEY REFERENCES cli_sessions(session_id) ON DELETE CASCADE,
    text TEXT,
    source TEXT CHECK(source IN ('claude','cc')),
    at INTEGER,
    position TEXT,
    away_from INTEGER,
    call_day TEXT NOT NULL DEFAULT '',
    call_count INTEGER NOT NULL DEFAULT 0
  ) STRICT`)
}
