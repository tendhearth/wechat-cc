import type { Migration } from './types'

// v54 — retained task execution choice and immutable choices for accepted runs.
export const migration: Migration = (db) => {
    const columns=db.query<{name:string},[]>('PRAGMA table_info(workbench_tasks)').all()
    if(!columns.some(column=>column.name==='execution_choice_json')) {
      db.exec(`ALTER TABLE workbench_tasks ADD COLUMN execution_choice_json TEXT NOT NULL DEFAULT '{"defaults":"provider","model":null,"reasoningEffort":null}';`)
      db.exec(`UPDATE workbench_tasks SET execution_choice_json='{"defaults":"native","model":null,"reasoningEffort":null}' WHERE id IN (SELECT task_id FROM workbench_sources);`)
    }
    db.exec(`CREATE TABLE IF NOT EXISTS workbench_run_execution (
      run_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES workbench_tasks(id),
      choice_json TEXT NOT NULL, effective_json TEXT,
      created_at INTEGER NOT NULL, observed_at INTEGER
    ) STRICT;
    CREATE INDEX IF NOT EXISTS workbench_run_execution_task ON workbench_run_execution(task_id,created_at);`)
    const inputs=db.query<{name:string},[]>('PRAGMA table_info(workbench_live_inputs)').all()
    if(!inputs.some(column=>column.name==='execution_json'))db.exec('ALTER TABLE workbench_live_inputs ADD COLUMN execution_json TEXT')
  }
