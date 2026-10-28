import type { Migration } from './types'

// v65 — 回报的投递队列。回报的"痕"在原对话的流里(不新增事实源);这张表只管
// 送达:票据过期不算失败(照提醒那条路的教训),存 pending、人回来补发、绝不烧重试。
export const migration: Migration = (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS matter_report_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        matter_id TEXT NOT NULL REFERENCES matters(id),
        origin_matter_id TEXT NOT NULL REFERENCES matters(id),
        origin_message_id TEXT,
        text TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','dropped')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS matter_report_outbox_due ON matter_report_outbox(status, next_at);
    `)
  }
