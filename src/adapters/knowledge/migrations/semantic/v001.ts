import type { Migration } from '../../../../lib/db'

// v1 — semantic.db 今天的结构(G1 从 store.ts 原样搬来,幂等)。分块 + 向量 + 自己内容的 FTS5(trigram)。
export const migration: Migration = (db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      rowid INTEGER PRIMARY KEY,
      msg_key TEXT, conversation TEXT, sender TEXT,
      time INTEGER, kind TEXT, text TEXT,
      vector BLOB, model_id TEXT, model_version TEXT,
      UNIQUE(msg_key, model_id)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, tokenize='trigram');
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  `)
}
