import type { Migration } from './types'

// v70 — 对主人微信聊天那件事「说一句」的 requestId 回执(手机「不确定」后重发不说两遍)。
// 与工作台输入回执(workbench_live_inputs)同一姿势:持久、同 id 异文 ⇒ input_conflict;
// 只存正文的 sha256,不存正文。见 src/adapters/store/say-receipts.ts。
export const migration: Migration = (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS matter_say_receipts (
      request_id TEXT PRIMARY KEY, matter_id TEXT NOT NULL,
      text_hash TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','replied')),
      reply TEXT, created_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS matter_say_receipts_created ON matter_say_receipts(created_at);`)
  }
