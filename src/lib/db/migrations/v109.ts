import type { Migration } from './types'

// v109 — keep owner-scoped topic aliases after a merge, so old references remain resolvable.
export const migration: Migration = db => {
  db.exec(`CREATE TABLE IF NOT EXISTS topic_merge_aliases (
    chat_id TEXT NOT NULL,
    old_id TEXT NOT NULL,
    surviving_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    PRIMARY KEY(chat_id,old_id)
  );
  CREATE TABLE IF NOT EXISTS conversation_work_references (
    chat_id TEXT NOT NULL,
    matter_id TEXT NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    PRIMARY KEY(chat_id,matter_id)
  )`)
}
