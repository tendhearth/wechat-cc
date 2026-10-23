import type { Migration } from './types'

// v74 — 独立工作区(2026-10-07):一件事在 `<stateDir>/worktrees/...` 的 git worktree 里做,分支 cc/<8 位>。
//
// WHY 另起一张表而不是往 workbench_tasks 加列:任务本身照旧是「项目」任务(路径就是工作区里的目录),
// 占用 / 快照 / 续接一行不改;这张表只回答「这件事是不是独立工作区、源项目在哪、分支叫什么、目录删了没」。
// removed_at 非空 = 工作区目录已删(分支保留)。
export const migration: Migration = (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS workbench_worktrees (
      task_id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      repo_root TEXT NOT NULL,
      root TEXT NOT NULL,
      branch TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      removed_at INTEGER
    );`)
  }
