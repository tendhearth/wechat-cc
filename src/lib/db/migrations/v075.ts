import type { Migration } from './types'

// v75 — 独立工作区「合回项目」(2026-10-08):记下快进合并进项目的时间,任务页显示「已合回」。
// NULL = 还没合 / 主人自己在外面合的(那种情况点一下「合回项目」会认出来并补记)。守表同 v73。
export const migration: Migration = (db) => {
    const has = db
      .query<{ cnt: number }, []>("SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type='table' AND name='workbench_worktrees'")
      .get()
    if (!has || has.cnt === 0) return
    const cols = new Set(db.query<{ name: string }, []>("PRAGMA table_info('workbench_worktrees')").all().map(c => c.name))
    if (!cols.has('merged_at')) db.exec(`ALTER TABLE workbench_worktrees ADD COLUMN merged_at INTEGER;`)
  }
