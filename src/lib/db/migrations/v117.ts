import type {Migration} from './types'

// v117 — 「地方」:正面上半那几行的顺序由主人定(设计稿 2026-11-18-cc-two-sides-design.md §3)。一个项目根目录一行;hidden = 主人收起。
export const migration: Migration = db=>{
  db.exec(`CREATE TABLE IF NOT EXISTS places (
    key TEXT PRIMARY KEY,
    root TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    position INTEGER NOT NULL,
    hidden INTEGER NOT NULL DEFAULT 0 CHECK(hidden IN (0,1)),
    created_at INTEGER NOT NULL
  ) STRICT;`)
}
