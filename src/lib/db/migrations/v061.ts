import type { Migration } from './types'

// v61: 工作台实时事件流 —— 任务变更序号(持久化)与事件行的 seq(长轮询只取 seq > since 的行)。
export const migration: Migration = (db) => {
    const has = (table: string, column: string) => db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().some(c => c.name === column)
    if (!has('workbench_tasks', 'seq')) db.exec('ALTER TABLE workbench_tasks ADD COLUMN seq INTEGER NOT NULL DEFAULT 0')
    if (!has('workbench_events', 'seq')) db.exec('ALTER TABLE workbench_events ADD COLUMN seq INTEGER NOT NULL DEFAULT 0')
    db.exec('CREATE INDEX IF NOT EXISTS workbench_events_task_seq ON workbench_events(task_id, seq)')
  }
