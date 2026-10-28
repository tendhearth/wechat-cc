import type { Migration } from './types'
import { hasTable } from '../schema-helpers'

// v82 — 每件事花了多少额度(2026-10-20,第二轮对标 ★3,对标 Devin per-session 用量):执行者自己在一轮结束时报的 token,
// 一轮一行,(run_id, turn_seq) 是主键 ⇒ 同一个 result 重放 INSERT OR IGNORE 不重复累加。不估;cost 只在执行者明确
// 报的是这一轮的钱时才写(目前没有一家写),空 ⇒ 界面写「这家不报」。另起一张表(同 v74 / v80 的理由)。
export const migration: Migration = (db) => {
    if(!hasTable(db,'workbench_tasks'))return
    db.exec(`CREATE TABLE IF NOT EXISTS workbench_turn_usage (
      task_id TEXT NOT NULL REFERENCES workbench_tasks(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL,
      turn_seq INTEGER NOT NULL,
      provider_id TEXT NOT NULL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_write_tokens INTEGER,
      reasoning_tokens INTEGER,
      cost_usd REAL,
      duration_ms INTEGER,
      at INTEGER NOT NULL,
      PRIMARY KEY(run_id, turn_seq)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS workbench_turn_usage_task ON workbench_turn_usage(task_id, at);`)
  }
