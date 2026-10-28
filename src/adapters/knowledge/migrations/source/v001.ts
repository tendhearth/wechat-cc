import type { Migration } from '../../../../lib/db'

// v1 — source.db 今天的结构(G1 从 store.ts 原样搬来,保持幂等:存量库 user_version 是 0,跑一遍什么都不变)。
// 早期(Phase 0/1)的 messages 只有 8 列,CREATE TABLE IF NOT EXISTS 对它是空操作 ⇒ 缺哪列补哪列,再建索引(kind 列的索引要在补列之后)。
export const migration: Migration = (db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      msg_key TEXT PRIMARY KEY,
      conversation TEXT, sender TEXT, time INTEGER,
      type TEXT, text TEXT, server_id TEXT,
      local_type INTEGER, is_group INTEGER, kind TEXT,
      ingested_watermark INTEGER
    );
    CREATE TABLE IF NOT EXISTS contacts (
      username TEXT PRIMARY KEY, display TEXT
    );
    CREATE TABLE IF NOT EXISTS source_meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS source_mentions (msg_key TEXT, target_un TEXT);
    CREATE INDEX IF NOT EXISTS source_mentions_msg_key ON source_mentions(msg_key);
  `)
  const existing = new Set(db.query<{ name: string }, []>('PRAGMA table_info(messages)').all().map(r => r.name))
  for (const [col, ddlType] of [
    ['local_type', 'INTEGER'],
    ['is_group', 'INTEGER'],
    ['kind', 'TEXT'],
  ] as const) {
    if (!existing.has(col)) db.exec(`ALTER TABLE messages ADD COLUMN ${col} ${ddlType}`)
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS messages_watermark ON messages(ingested_watermark);
    CREATE INDEX IF NOT EXISTS messages_kind ON messages(kind);
    CREATE INDEX IF NOT EXISTS messages_time ON messages(time);
  `)
}
