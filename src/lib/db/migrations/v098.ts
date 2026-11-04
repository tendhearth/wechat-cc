import type { Migration } from './types'

// v98 — 终端会话的记录读到哪了(2026-11-04,设计稿 2026-11-04-m4-terminal-matter-design.md §M4b)。
// 一件 kind='terminal' 的事一行:读的是哪份记录(path)、读到第几个字节(offset,只到最后一个换行)、
// 第几次从头读(gen:记录被截短 / 换了一份 / 一下子跳过一大段 ⇒ 加一,步的 key 带上它,和上一次读进来的撞不上)、
// 还在等结果的工具调用(pending_json:调用 id → [那一步的 key, 要不要挂输出])。解析出的步本身经 MatterLog 进 matter_items。
// 只有 adapters/store/terminal-steps.ts 读写这一张。可重放:IF NOT EXISTS。
export const migration: Migration = (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS terminal_reads (
        matter_id TEXT PRIMARY KEY REFERENCES matters(id),
        path TEXT NOT NULL,
        offset INTEGER NOT NULL,
        gen INTEGER NOT NULL DEFAULT 0,
        pending_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(pending_json)),
        updated_at INTEGER NOT NULL
      ) STRICT;
    `)
  }
