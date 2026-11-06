import type { Migration } from './types'

// v106 — T4:泡泡与真正采用的回忆引用。历史话题默认收起;不复制消息正文。
export const migration: Migration = (db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS topic_bubbles (
      thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
      state TEXT NOT NULL DEFAULT 'closed' CHECK(state IN ('open','closed')),
      opened_at TEXT,
      last_recalled_at TEXT,
      last_opened_by_owner_at TEXT,
      activity_revision INTEGER NOT NULL DEFAULT 0,
      closed_sleep_id TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS topic_bubble_requests (
      chat_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('recall','search','owner')),
      created_at TEXT NOT NULL,
      PRIMARY KEY(chat_id, request_id, kind)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS topic_recall_refs (
      chat_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      entry_ids TEXT NOT NULL DEFAULT '[]',
      message_ids TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      PRIMARY KEY(chat_id, request_id, thread_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS topic_recall_refs_thread ON topic_recall_refs(thread_id, created_at);
  `)
}
