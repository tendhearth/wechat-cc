import type { Migration } from './types'

// v90 — 生成物的过期围栏进主库(架构终态 G8,设计稿 docs/superpowers/specs/2026-10-25-memory-single-source-design.md §3):
// 以前每个对话目录里一份 .derived-state.json。这里一个对话一行:rev = 源修订号(每次改源 +1),
// overview_retracted / profile_retracted = 上次生成以后有没有碰到过「收回」(碰到过 ⇒ 过期时藏起来,不只是贴标签)。
// 生成物本身(正文 + 生成时的 rev)在 v87 的 memory_derived。带 IF NOT EXISTS(#79 的修复会重放后面的迁移)。
export const migration: Migration = (db) => {
  db.exec(`CREATE TABLE IF NOT EXISTS memory_source_revisions (
    chat_id TEXT PRIMARY KEY NOT NULL,
    rev INTEGER NOT NULL DEFAULT 0,
    overview_retracted INTEGER NOT NULL DEFAULT 0 CHECK(overview_retracted IN (0, 1)),
    profile_retracted INTEGER NOT NULL DEFAULT 0 CHECK(profile_retracted IN (0, 1)),
    updated_at INTEGER NOT NULL
  ) STRICT;`)
}
