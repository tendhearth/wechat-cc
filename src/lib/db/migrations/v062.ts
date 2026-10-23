import type { Migration } from './types'

// v62: workbench_review_marks(逐文件审阅标记)
export const migration: Migration = (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS workbench_review_marks (
        task_id TEXT NOT NULL, artifact_sha256 TEXT NOT NULL, path TEXT NOT NULL,
        after_sha256 TEXT, mark TEXT NOT NULL CHECK(mark IN ('accepted','returned')),
        comment TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
        PRIMARY KEY(task_id, artifact_sha256, path)
      ) STRICT;
    `)
  }
