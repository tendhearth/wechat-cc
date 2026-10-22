import type { Migration } from './types'

// v51 — ordered native activity updates, isolated by task and dispatch run.
export const migration: Migration = (db) => {
    const columns=new Set(db.query<{name:string},[]>('PRAGMA table_info(workbench_events)').all().map(c=>c.name))
    for(const column of ['run_id','event_key','activity_json']) {
      if(!columns.has(column))db.exec(`ALTER TABLE workbench_events ADD COLUMN ${column} TEXT`)
    }
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS workbench_events_native_item ON workbench_events(task_id,run_id,event_key) WHERE event_key IS NOT NULL')
  }
