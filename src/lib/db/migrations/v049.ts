import type { Migration } from './types'

// v49 — version-pinned review and revision provenance.
export const migration: Migration = (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS workbench_handoffs (
        id TEXT PRIMARY KEY, source_task_id TEXT NOT NULL REFERENCES workbench_tasks(id),
        target_task_id TEXT NOT NULL REFERENCES workbench_tasks(id),
        purpose TEXT NOT NULL CHECK(purpose IN ('review','revision')), request TEXT NOT NULL,
        packet_sha256 TEXT NOT NULL, artifact_refs_json TEXT NOT NULL, quote_json TEXT,
        created_at INTEGER NOT NULL, request_event_id INTEGER REFERENCES workbench_events(id),
        source_native_id TEXT, target_native_id TEXT,
        packet_json TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE
      ) STRICT;
      CREATE INDEX IF NOT EXISTS workbench_handoffs_source ON workbench_handoffs(source_task_id,created_at);
      CREATE INDEX IF NOT EXISTS workbench_handoffs_target ON workbench_handoffs(target_task_id,created_at);
    `)
  }
