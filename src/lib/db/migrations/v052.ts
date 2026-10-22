import type { Migration } from './types'

// v52 — durable run-bound receipts for phone control actions, separate from task inputs.
export const migration: Migration = (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS workbench_control_receipts (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES workbench_tasks(id),
      run_id TEXT, action TEXT NOT NULL CHECK(action IN ('stop')),
      text_hash TEXT NOT NULL, result TEXT, created_at INTEGER NOT NULL
    ) STRICT;`)
  }
