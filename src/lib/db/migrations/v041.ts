import type { Migration } from './types'

// v41 — reminders 表少列的自愈。v29 用 `CREATE TABLE IF NOT EXISTS reminders`
// 建表,但六月的 feat/reminders(当时编号 v15)先建过一版**没有**
// last_attempt_at 的 reminders 表。跑过那条老分支的库里表已存在,v29 的
// IF NOT EXISTS 直接跳过,列就永远补不上 —— sweeper 每次 SELECT/UPDATE
// last_attempt_at 都抛 "no such column: last_attempt_at",reminders 子系统
// 每次启动都 degraded。和 v32/v33/v34 同一个形状:表在、列缺。
// 区别是这几列在**全新装**的库里(v29 建的)本就存在,ALTER ADD 已存在的列会
// 报 duplicate,所以不能像 v32 那样无脑 ALTER —— 先用 table_info 探缺哪列、
// 只补缺的。Nullable-TEXT / 带 DEFAULT 的 INTEGER ADD COLUMN 在 STRICT 表安全。
export const migration: Migration = (db) => {
    const found = db
      .query<{ cnt: number }, []>("SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type='table' AND name='reminders'")
      .get()
    if (!found || found.cnt === 0) return
    const cols = new Set(
      db.query<{ name: string }, []>('PRAGMA table_info(reminders)').all().map((r) => r.name),
    )
    if (!cols.has('attempts')) db.exec('ALTER TABLE reminders ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;')
    if (!cols.has('last_error')) db.exec('ALTER TABLE reminders ADD COLUMN last_error TEXT;')
    if (!cols.has('last_attempt_at')) db.exec('ALTER TABLE reminders ADD COLUMN last_attempt_at TEXT;')
  }
