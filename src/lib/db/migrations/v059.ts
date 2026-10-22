import type { Migration } from './types'
import { hasTable } from '../schema-helpers'

// v59 — 补 v49 漏掉的列。v49 建 workbench_handoffs 用的是 CREATE TABLE IF
// NOT EXISTS,而 request_event_id 是在这张表已经被建出来之后才加进那条语句的
// —— 对存量库是空操作,列永远补不上,于是 store.detail() 的 HANDOFF_SELECT
// 每次都抛 "no such column",工作台一个任务都打不开(2026-09-15 真机)。
// 只能追加新迁移,不能改 v49:user_version 是计数,改旧条目对已过该位的库无效。
export const migration: Migration = (db) => {
    if(!hasTable(db,'workbench_handoffs'))return
    const columns=db.query<{name:string},[]>('PRAGMA table_info(workbench_handoffs)').all()
    if(!columns.some(column=>column.name==='request_event_id'))db.exec('ALTER TABLE workbench_handoffs ADD COLUMN request_event_id INTEGER REFERENCES workbench_events(id)')
  }
