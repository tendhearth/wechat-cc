import type { Migration } from './types'

// v88 — 记忆搬进表的账(架构终态 G3 / G4,设计稿 docs/superpowers/specs/2026-10-25-memory-single-source-design.md §3):
// memory_import 一个对话一行:上次「文件 → 表」核对通过时三份文件(memory.md / owner.md / corrections.md)的总指纹;
// 开机看到指纹变了才再同步一次。memory_exports 一个对话一份文件一行:我们最后一次导出时写下的内容指纹,
// 磁盘上的文件和它不一样 ⇒ 有人在 daemon 之外改过(老版本二进制或主人用编辑器改)。
export const migration: Migration = (db) => {
  db.exec(`CREATE TABLE IF NOT EXISTS memory_import (
    chat_id TEXT PRIMARY KEY NOT NULL,
    files_hash TEXT NOT NULL,
    at INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS memory_exports (
    chat_id TEXT NOT NULL,
    file TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY(chat_id, file)
  ) STRICT;`)
}
