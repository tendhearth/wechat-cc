import type { Migration } from './types'

// v50 — task/run-bound supplemental input, never replayed after restart.
export const migration: Migration = (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS workbench_live_inputs (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES workbench_tasks(id),
      run_id TEXT NOT NULL, text TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','sending','delivered','held','withdrawn')),
      created_at INTEGER NOT NULL, error TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS workbench_live_inputs_task ON workbench_live_inputs(task_id,status);`)
  }
