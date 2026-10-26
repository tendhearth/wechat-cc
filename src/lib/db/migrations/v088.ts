import type { Migration } from './types'

// v88 — 记忆搬进表的账(架构终态 G3 / G4,设计稿 docs/superpowers/specs/2026-10-25-memory-single-source-design.md §3):
// memory_import 一个对话一行:上次「文件 → 表」核对通过时三份文件(memory.md / owner.md / corrections.md)的总指纹;
// 开机看到指纹变了才再同步一次。memory_exports 一个对话一份文件一行:sha256 = 我们最后一次**确认写到磁盘上**的内容指纹,
// pending_sha256 = 表已经改了、正要写的那份(写成功就清掉)。磁盘和 sha256 一样、pending 还在 ⇒ 上次导出写失败了,表比文件新,
// 重新导出;磁盘和两个都不一样 ⇒ 有人在 daemon 之外改过,先存档、再按手改处理。
export const migration: Migration = (db) => {
  db.exec(`CREATE TABLE IF NOT EXISTS memory_import (
    chat_id TEXT PRIMARY KEY NOT NULL,
    files_hash TEXT NOT NULL,
    at INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS memory_exports (
    chat_id TEXT NOT NULL,
    file TEXT NOT NULL,
    sha256 TEXT,
    pending_sha256 TEXT,
    at INTEGER NOT NULL,
    PRIMARY KEY(chat_id, file)
  ) STRICT;`)
}
