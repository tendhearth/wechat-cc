import type { Migration } from './types'

// v46 — durable desktop tasks, event history and immutable deliverables.
export const migration: Migration = (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS workbench_tasks (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, path TEXT NOT NULL,
        provider_id TEXT NOT NULL, owner_chat_id TEXT, session_id TEXT,
        status TEXT NOT NULL CHECK(status IN ('queued','running','cancelling','completed','failed','cancelled','interrupted')),
        error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS workbench_events (
        id INTEGER PRIMARY KEY, task_id TEXT NOT NULL REFERENCES workbench_tasks(id),
        kind TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS workbench_events_task ON workbench_events(task_id, id);
      CREATE TABLE IF NOT EXISTS workbench_artifacts (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES workbench_tasks(id),
        name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
        sha256 TEXT NOT NULL, storage_path TEXT NOT NULL,
        created_at INTEGER NOT NULL, approved_at INTEGER,
        UNIQUE(task_id, name, sha256)
      ) STRICT;
    `)
  }
