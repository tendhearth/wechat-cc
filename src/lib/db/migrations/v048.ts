import type { Migration } from './types'

// v48 — immutable provenance for explicitly imported native sessions.
export const migration: Migration = (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS workbench_sources (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE REFERENCES workbench_tasks(id),
        provider_id TEXT NOT NULL CHECK(provider_id IN ('claude','codex')), native_id TEXT NOT NULL,
        cwd TEXT NOT NULL, imported_at INTEGER NOT NULL, first_dispatched_at INTEGER,
        snapshot_sha256 TEXT NOT NULL, observed_fingerprint TEXT NOT NULL,
        selected_message_count INTEGER NOT NULL, truncated INTEGER NOT NULL CHECK(truncated IN (0,1)),
        snapshot_json TEXT NOT NULL, pages_json TEXT NOT NULL,
        UNIQUE(provider_id,native_id)
      ) STRICT;
    `)
    const columns=db.query<{name:string},[]>('PRAGMA table_info(workbench_events)').all()
    if(!columns.some(column=>column.name==='source_id'))db.exec('ALTER TABLE workbench_events ADD COLUMN source_id TEXT REFERENCES workbench_sources(id)')
  }
