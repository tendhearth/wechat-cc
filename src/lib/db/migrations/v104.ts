import type { Migration } from './types'

// v104 — 话题升格(T1,设计稿 docs/superpowers/specs/2026-11-05-topics-t1-t3-design.md §T1)。
//  - threads 加 aliases(CC 定的「主人会怎么叫它」,JSON 数组;T2 的索引匹配用)。老行先填成它的 tags 里**只有它自己用**的那几个
//    (「bx」);好几个话题共用的大类(「产品开发」)不当别名 —— 否则一句话里说到「产品开发」就同时碰到六个话题;
//  - 新表 topic_entries:一行一件事 + 一行索引(line),承诺单独一类(kind='commitment',可带 due);只标 done / superseded,不删;
//  - 睡一觉的整理(每晚)把一个话题里重复的进展并成一条:旧的标 superseded、superseded_by 指向新的那条(不删);
//  - thread_extract_state 加三列新水位:entries_to_ts(对话)、work_cursor(MatterLog 的 matter_items.cursor)、
//    consolidated_to_ts(睡一觉整理到哪)。
//    老的 extracted_to_ts 不再读;新水位从空开始 ⇒ 历史按新格式重读一遍,老话题当「已有话题」往里补条目,不重建。
// 可重放:列在就跳过,表 / 索引 IF NOT EXISTS,aliases 只填还是 '[]' 的行。
export const migration: Migration = (db) => {
  const has = (table: string, col: string) => db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().some(c => c.name === col)
  if (!has('threads', 'aliases')) db.exec(`ALTER TABLE threads ADD COLUMN aliases TEXT NOT NULL DEFAULT '[]'`)
  db.exec(`
    UPDATE threads SET aliases = (
      SELECT json_group_array(j.value) FROM json_each(threads.tags) j
      WHERE (SELECT COUNT(*) FROM threads t2, json_each(t2.tags) j2
             WHERE t2.chat_id = threads.chat_id AND json_valid(t2.tags) AND json_type(t2.tags) = 'array' AND j2.value = j.value) = 1
    )
    WHERE aliases = '[]' AND json_valid(tags) AND json_type(tags) = 'array'
  `)
  if (!has('thread_extract_state', 'entries_to_ts')) db.exec('ALTER TABLE thread_extract_state ADD COLUMN entries_to_ts TEXT')
  if (!has('thread_extract_state', 'work_cursor')) db.exec('ALTER TABLE thread_extract_state ADD COLUMN work_cursor INTEGER NOT NULL DEFAULT 0')
  if (!has('thread_extract_state', 'consolidated_to_ts')) db.exec('ALTER TABLE thread_extract_state ADD COLUMN consolidated_to_ts TEXT')
  db.exec(`
    CREATE TABLE IF NOT EXISTS topic_entries (
      id          TEXT PRIMARY KEY NOT NULL,
      thread_id   TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      kind        TEXT NOT NULL CHECK (kind IN ('fact','decision','commitment','progress','conclusion')),
      line        TEXT NOT NULL,
      body        TEXT NOT NULL DEFAULT '',
      due         TEXT,
      status      TEXT NOT NULL DEFAULT 'live' CHECK (status IN ('live','done','superseded')),
      source      TEXT NOT NULL CHECK (source IN ('chat','work','delegate')),
      matter_id   TEXT,
      superseded_by TEXT,
      created_ts  TEXT NOT NULL,
      updated_ts  TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS topic_entries_thread ON topic_entries(thread_id, status, updated_ts);
    CREATE INDEX IF NOT EXISTS topic_entries_matter ON topic_entries(matter_id) WHERE matter_id IS NOT NULL;
  `)
  // 这一列是同一条迁移在分支上后加的(进 dev 之前):表若已被分支上更早的这一版建过,补上
  if (!has('topic_entries', 'superseded_by')) db.exec('ALTER TABLE topic_entries ADD COLUMN superseded_by TEXT')
}
