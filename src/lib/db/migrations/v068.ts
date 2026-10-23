import type { Migration } from './types'

// v68 — channel-independent creation receipts and trusted attachment ownership.
export const migration: Migration = (db) => {
    const tasks=db.query<{name:string},[]>('PRAGMA table_info(workbench_tasks)').all()
    if(!tasks.some(column=>column.name==='workspace_kind'))db.exec("ALTER TABLE workbench_tasks ADD COLUMN workspace_kind TEXT NOT NULL DEFAULT 'project' CHECK(workspace_kind IN ('project','managed'))")
    const attachments=db.query<{name:string},[]>('PRAGMA table_info(workbench_attachments)').all()
    if(!attachments.some(column=>column.name==='owner_key'))db.exec('ALTER TABLE workbench_attachments ADD COLUMN owner_key TEXT')
    db.exec(`
      CREATE TABLE IF NOT EXISTS workbench_entry_requests (
        owner_key TEXT NOT NULL, request_id TEXT NOT NULL,
        canonical_request_hash TEXT NOT NULL,
        frozen_json TEXT NOT NULL CHECK(json_valid(frozen_json)),
        phase TEXT NOT NULL CHECK(phase IN ('reserved','accepted')),
        workspace_id TEXT UNIQUE, resolved_path TEXT, directory_identity TEXT,
        task_id TEXT REFERENCES workbench_tasks(id), matter_id TEXT REFERENCES matters(id),
        run_id TEXT, accepted_at INTEGER, created_at INTEGER NOT NULL,
        PRIMARY KEY(owner_key, request_id),
        CHECK((phase='reserved' AND task_id IS NULL AND matter_id IS NULL AND run_id IS NULL AND accepted_at IS NULL)
          OR (phase='accepted' AND task_id IS NOT NULL AND matter_id IS NOT NULL AND matter_id=task_id
            AND run_id IS NOT NULL AND length(run_id)>0 AND accepted_at IS NOT NULL AND accepted_at>0
            AND resolved_path IS NOT NULL AND length(resolved_path)>0
            AND directory_identity IS NOT NULL AND length(directory_identity)>0))
      ) STRICT;
    `)
  }
