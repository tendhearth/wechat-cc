import type { Migration } from './types'

// v47 — task archive state and stable full-history listing order.
export const migration: Migration = (db) => {
    // Repair migrations can rewind user_version on an otherwise newer schema.
    const columns=db.query<{name:string},[]>('PRAGMA table_info(workbench_tasks)').all()
    if(!columns.some(column=>column.name==='archived_at'))db.exec('ALTER TABLE workbench_tasks ADD COLUMN archived_at INTEGER')
    db.exec(`
      CREATE INDEX IF NOT EXISTS workbench_tasks_visible_order ON workbench_tasks(updated_at DESC,id DESC) WHERE archived_at IS NULL;
      CREATE INDEX IF NOT EXISTS workbench_tasks_archived_order ON workbench_tasks(updated_at DESC,id DESC) WHERE archived_at IS NOT NULL;
    `)
  }
