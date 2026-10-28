import type { Migration } from './types'

// v63: projects survive empty/archived conversation lists. Existing canonical
// task paths remain the association key, including external session imports.
export const migration: Migration = (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS workbench_projects (
      id TEXT PRIMARY KEY NOT NULL,
      path TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT;
    INSERT OR IGNORE INTO workbench_projects(id,path,name,provider_id,created_at)
      SELECT 'p-' || lower(hex(randomblob(16))),path,'',provider_id,MIN(created_at)
      FROM workbench_tasks GROUP BY path;`)
  }
