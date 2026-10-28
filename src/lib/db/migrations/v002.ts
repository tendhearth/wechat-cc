import type { Migration } from './types'

// v2 — sessions (alias × provider → SDK session_id for resume). PR7 commit 2.
// Composite PK so a single alias can hold one claude + one codex session
// independently (legacy v0.x format collapsed both into a single row).
export const migration: Migration = (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        alias TEXT NOT NULL,
        provider TEXT NOT NULL,
        session_id TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        summary TEXT,
        summary_updated_at TEXT,
        PRIMARY KEY (alias, provider)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS sessions_alias_last_used ON sessions(alias, last_used_at DESC);
    `)
  }
