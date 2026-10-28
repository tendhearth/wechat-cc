import type { Migration } from './types'
import { hasTable } from '../schema-helpers'

// v80 — 一起做「做到条件成立为止」(2026-10-20,spec 2026-10-20-workbench-until-design):主人建任务时写的检查命令,
// 每轮做完在独立工作区里跑一次,没过就接着改,有轮数上限。command 写一次就定死(没有改它的接口)。
// 另起一张表(同 v74 的理由):大多数任务没有它,不往 workbench_tasks 加一堆可空列。
export const migration: Migration = (db) => {
    if(!hasTable(db,'workbench_tasks'))return
    db.exec(`CREATE TABLE IF NOT EXISTS workbench_goals (
      task_id TEXT PRIMARY KEY REFERENCES workbench_tasks(id) ON DELETE CASCADE,
      command TEXT NOT NULL,
      max_rounds INTEGER NOT NULL CHECK(max_rounds BETWEEN 1 AND 10),
      rounds INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK(status IN ('active','passed','exhausted','stopped')),
      last_exit INTEGER,
      stop_reason TEXT,
      checked_turn TEXT,
      updated_at INTEGER NOT NULL
    ) STRICT;`)
  }
