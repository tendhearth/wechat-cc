import type { Migration } from './types'

// v53 — immutable task input snapshots and ordered refs on durable input history.
export const migration: Migration = (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS workbench_attachments (
      id TEXT PRIMARY KEY, draft_id TEXT NOT NULL,
      task_id TEXT REFERENCES workbench_tasks(id), upload_task_id TEXT REFERENCES workbench_tasks(id),
      name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL CHECK(size>0 AND size<=8388608),
      sha256 TEXT NOT NULL, storage_path TEXT NOT NULL, created_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS workbench_attachments_task ON workbench_attachments(task_id,created_at);
    CREATE INDEX IF NOT EXISTS workbench_attachments_draft ON workbench_attachments(draft_id) WHERE task_id IS NULL;`)
    for(const table of ['workbench_events','workbench_live_inputs']) {
      const columns=db.query<{name:string},[]>(`PRAGMA table_info(${table})`).all()
      if(!columns.some(column=>column.name==='attachments_json'))db.exec(`ALTER TABLE ${table} ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]'`)
    }
  }
