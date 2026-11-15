import type {Migration} from './types'

// v114 — 分享一件事给合伙人:每个链接一行。令牌原样存:中继握手要两边拿同一个密钥(和手机设备令牌一样)。只加表,不动已有数据。
export const migration: Migration = db=>{
  db.exec(`CREATE TABLE IF NOT EXISTS matter_shares (
    id TEXT PRIMARY KEY,
    matter_id TEXT NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    revoked_at INTEGER, last_opened_at INTEGER
  ) STRICT;
  CREATE INDEX IF NOT EXISTS idx_matter_shares_matter ON matter_shares(matter_id);`)
}
