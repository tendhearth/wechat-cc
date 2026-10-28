import type { Migration } from './types'

// v91 — 挂着的拍板卡落一行(主人 2026-10-28 定:重启后告诉主人「重启前那张卡作废了」)。
// 待批登记处只在内存里,重启就没了;这张表只记「哪个 chat、卡上一句话说要做什么」,卡一开就写、一了结就删 ——
// daemon 崩了没走关机也留得下。下次开机把上一个进程留下的读出来,告诉主人一次,再删掉。不记码、不记命令全文。
// 带 IF NOT EXISTS(#79 的修复会重放后面的迁移)。
export const migration: Migration = (db) => {
  db.exec(`CREATE TABLE IF NOT EXISTS pending_cards (
    hash TEXT PRIMARY KEY NOT NULL,
    chat_id TEXT NOT NULL,
    summary TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  ) STRICT;`)
}
