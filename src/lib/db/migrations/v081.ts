import type { Migration } from './types'
import { hasTable } from '../schema-helpers'

// v81 — 一起做「回到某一轮」(2026-10-21,spec 2026-10-21-workbench-rewind-design):一次回退 / 撤销回退一行。
// 先插 state='applying'(意图),做完改 done、回滚改 failed;开机见到 applying 就按旧 HEAD 与备份核对现场(评审 4)。
// 制品与审阅标记不动,「已撤掉」只靠 discarded_json。守表同 v80。
// needs_owner = 回滚没回干净 / 开机对账说不清:这件事停住,直到主人选 resolution(keep 保留现状 / restore_backup 恢复备份)。
export const migration: Migration = (db) => {
    if(!hasTable(db,'workbench_tasks'))return
    db.exec(`CREATE TABLE IF NOT EXISTS workbench_rewinds (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES workbench_tasks(id) ON DELETE CASCADE,
      target_artifact_id TEXT NOT NULL,
      target_point TEXT NOT NULL CHECK(target_point IN ('start','end')),
      target_commit TEXT NOT NULL,
      prior_head TEXT NOT NULL,
      backup_ref TEXT NOT NULL,
      backup_commit TEXT NOT NULL,
      discarded_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('applying','done','failed','needs_owner')),
      resolution TEXT CHECK(resolution IN ('keep','restore_backup')),
      notice_sent_at INTEGER,
      created_at INTEGER NOT NULL,
      undone_at INTEGER
    ) STRICT;
    CREATE INDEX IF NOT EXISTS workbench_rewinds_task ON workbench_rewinds(task_id, created_at);`)
  }
