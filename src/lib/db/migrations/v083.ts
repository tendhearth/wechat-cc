import type { Migration } from './types'
import { hasTable } from '../schema-helpers'

// v83 — 一起做「行评论 + 按块撤回」(2026-10-21,spec 2026-10-21-workbench-line-review-design):
// 评论锚在 (快照 sha, 路径, 块序号, 块 sha, 块内行) 上 —— 快照不可变,锚点不漂;id 由客户端生成(幂等)。
// 引用与行号由服务端从快照算好存下。另起新表,不扩 v62(一文件一个标记,重建表要踩 foreign_keys / rename 的坑)。
// workbench_review_hunks 只是留痕(界面「已撤回」小签),写入路径从不信它。守表同 v80。
export const migration: Migration = (db) => {
    if(!hasTable(db,'workbench_tasks'))return
    db.exec(`CREATE TABLE IF NOT EXISTS workbench_review_comments (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES workbench_tasks(id) ON DELETE CASCADE,
      artifact_id TEXT NOT NULL,
      artifact_sha256 TEXT NOT NULL,
      path TEXT NOT NULL,
      hunk_index INTEGER NOT NULL,
      hunk_sha256 TEXT NOT NULL,
      row_start INTEGER,
      row_end INTEGER,
      side TEXT,
      line_start INTEGER,
      line_end INTEGER,
      quote TEXT NOT NULL,
      body TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('draft','sent')),
      sent_request_id TEXT,
      sent_at INTEGER,
      resolved_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS workbench_review_comments_task ON workbench_review_comments(task_id, state, created_at);
    CREATE TABLE IF NOT EXISTS workbench_review_hunks (
      task_id TEXT NOT NULL REFERENCES workbench_tasks(id) ON DELETE CASCADE,
      artifact_sha256 TEXT NOT NULL,
      path TEXT NOT NULL,
      hunk_index INTEGER NOT NULL,
      hunk_sha256 TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('reverted','restored')),
      notified_at INTEGER,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(task_id, artifact_sha256, path, hunk_index)
    ) STRICT;`)
  }
