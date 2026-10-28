import type { Migration } from './types'

// v69 — durable bounded upload reservations shared by desktop and phone.
export const migration: Migration = (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS workbench_attachment_uploads (
      id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, draft_id TEXT NOT NULL, task_id TEXT,
      name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL CHECK(size>0), sha256 TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('uploading','finalizing','ready','discarded','expired')),
      next_offset INTEGER NOT NULL DEFAULT 0 CHECK(next_offset>=0 AND next_offset<=size),
      chunks_json TEXT NOT NULL DEFAULT '[]', part_identity TEXT,
      reserved_bytes INTEGER NOT NULL CHECK(reserved_bytes>=0),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS uploads_owner_status ON workbench_attachment_uploads(owner_key,status);
    CREATE INDEX IF NOT EXISTS uploads_expiry ON workbench_attachment_uploads(status,expires_at);`)
  }
