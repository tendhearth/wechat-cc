import type { Migration } from './types'

// v55 — immutable receipts for idempotent phone-created workbench tasks.
export const migration: Migration = (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS workbench_creation_receipts (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      owner_chat_id TEXT NOT NULL,
      command_hash TEXT NOT NULL,
      project_id TEXT NOT NULL,
      path TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      task_id TEXT NOT NULL REFERENCES workbench_tasks(id),
      run_id TEXT NOT NULL,
      reply TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS workbench_creation_receipts_task ON workbench_creation_receipts(task_id);`)
  }
