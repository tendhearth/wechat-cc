import type { Migration } from './types'

// v105 — 一件事挂话题(T3,设计稿 docs/superpowers/specs/2026-11-05-topics-t1-t3-design.md §T3)。
// matter_topics:这件事挂在哪几个话题上,结论写回到 MatterLog 的哪一条(matter_items.cursor)。
// matter_id 不加外键:delegate 一次咨询没有 matter,以后也可能挂别的来源;话题删了跟着删。
// 可重放:IF NOT EXISTS。
export const migration: Migration = (db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS matter_topics (
      matter_id           TEXT NOT NULL,
      thread_id           TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      attached_ts         TEXT NOT NULL,
      written_back_cursor INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (matter_id, thread_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS matter_topics_thread ON matter_topics(thread_id);
  `)
}
