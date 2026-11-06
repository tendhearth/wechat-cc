import type { Migration } from './types'

// v106 — T4:泡泡与真正采用的回忆引用。历史话题默认收起;不复制消息正文。
export const migration: Migration = (db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS topic_bubble_revisions (
      chat_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL DEFAULT 0
    ) STRICT;
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
  // 持久 owner 范围版本只在写口递增。读取/订阅不为了算版本扫描或哈希历史正文。
  for (const [table, scope] of [
    ['threads', (row: string) => `${row}.chat_id`],
    ['topic_recall_refs', (row: string) => `${row}.chat_id`],
    ['topic_entries', (row: string) => `(SELECT chat_id FROM threads WHERE id=${row}.thread_id)`],
    ['topic_bubbles', (row: string) => `(SELECT chat_id FROM threads WHERE id=${row}.thread_id)`],
    ['matter_topics', (row: string) => `(SELECT chat_id FROM threads WHERE id=${row}.thread_id)`],
  ] as const) {
    for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
      const row = event === 'DELETE' ? 'OLD' : 'NEW'
      db.exec(`CREATE TRIGGER IF NOT EXISTS t4_${table}_${event.toLowerCase()} AFTER ${event} ON ${table}
        WHEN ${scope(row)} IS NOT NULL BEGIN
        INSERT INTO topic_bubble_revisions(chat_id,revision) VALUES(${scope(row)},1)
        ON CONFLICT(chat_id) DO UPDATE SET revision=revision+1;
        END;`)
    }
  }
  // Matters 的统一状态/标题/归档变化;外人的关联事项不会推进主人的版本。
  for (const event of ['UPDATE', 'DELETE']) {
    const row = event === 'DELETE' ? 'OLD' : 'NEW'
    const changed = event === 'UPDATE' ? `WHEN NEW.state IS NOT OLD.state OR NEW.title IS NOT OLD.title
      OR NEW.archived_at IS NOT OLD.archived_at OR NEW.owner_chat_id IS NOT OLD.owner_chat_id
      OR NEW.kind IS NOT OLD.kind OR NEW.project_path IS NOT OLD.project_path` : ''
    db.exec(`CREATE TRIGGER IF NOT EXISTS t4_matters_${event.toLowerCase()} AFTER ${event} ON matters ${changed} BEGIN
      INSERT INTO topic_bubble_revisions(chat_id,revision)
      SELECT DISTINCT t.chat_id,1 FROM threads t JOIN matter_topics l ON l.thread_id=t.id
      WHERE l.matter_id=${row}.id AND t.chat_id=${row}.owner_chat_id AND ${row}.kind!='act'
      ON CONFLICT(chat_id) DO UPDATE SET revision=revision+1;
      END;`)
  }
  for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
    const row = event === 'DELETE' ? 'OLD' : 'NEW'
    db.exec(`CREATE TRIGGER IF NOT EXISTS t4_messages_${event.toLowerCase()} AFTER ${event} ON messages BEGIN
      INSERT INTO topic_bubble_revisions(chat_id,revision)
      SELECT DISTINCT t.chat_id,1 FROM threads t WHERE t.chat_id=${row}.chat_id AND (
        EXISTS(SELECT 1 FROM topic_recall_refs r, json_each(r.message_ids) j WHERE r.thread_id=t.id AND j.value=${row}.id)
        OR EXISTS(SELECT 1 FROM json_each(t.episodes) ep WHERE ${row}.ts>=json_extract(ep.value,'$.from_ts') AND ${row}.ts<=json_extract(ep.value,'$.to_ts')))
      ON CONFLICT(chat_id) DO UPDATE SET revision=revision+1;
      END;`)
  }
}
