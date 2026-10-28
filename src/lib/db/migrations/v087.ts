import type { Migration } from './types'

// v87 — 主人的事实只有一个源(架构终态 G2,设计稿 docs/superpowers/specs/2026-10-25-memory-single-source-design.md §2.1):
// memory_facts 一行一句话(memory.md 条目 / owner.md 原话 / 以后的联系人事实 / 收回后的墓碑),memory_fact_events 只追加的历史
// (一个对话的修订号 = 它最大的 seq;AUTOINCREMENT 保证 seq 永不回头),memory_derived 是总览 / 画像的缓存(input_rev 落后 ⇒ 过期)。
// 这一版只建表:还没人读、没人写(G3 起导入)。只有 doc / status / scope 用 CHECK 钉死,来源 / 动作 / 执行者的取值在 TS 类型里,以后加值不用重建表。
// 建表照前后迁移的惯例带 IF NOT EXISTS:#79 的修复会把位置拨回去、把后面的迁移重放一遍,重放必须是空操作。
export const migration: Migration = (db) => {
  db.exec(`CREATE TABLE IF NOT EXISTS memory_facts (
    id INTEGER PRIMARY KEY,
    chat_id TEXT NOT NULL,
    key TEXT NOT NULL,
    doc TEXT NOT NULL CHECK(doc IN ('memory','owner','contact')),
    subject TEXT NOT NULL,
    section TEXT,
    ord INTEGER NOT NULL DEFAULT 0,
    kind TEXT,
    predicate TEXT,
    related_contact TEXT,
    time_ref TEXT,
    confidence TEXT,
    text TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active','retracted','outdated','superseded','resolved')),
    source TEXT NOT NULL,
    origin TEXT,
    scope TEXT NOT NULL DEFAULT 'chat' CHECK(scope IN ('chat','owner_only')),
    evidence TEXT,
    seen_at TEXT,
    valid_from INTEGER,
    invalidated_at INTEGER,
    superseded_by INTEGER,
    replaces INTEGER REFERENCES memory_facts(id),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(chat_id, key)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS memory_facts_chat ON memory_facts(chat_id, doc, status, ord);
  CREATE INDEX IF NOT EXISTS memory_facts_subject ON memory_facts(subject, kind, status);
  CREATE TABLE IF NOT EXISTS memory_fact_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    fact_id INTEGER NOT NULL REFERENCES memory_facts(id),
    chat_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    action TEXT NOT NULL,
    actor TEXT NOT NULL,
    verdict TEXT,
    prev_text TEXT,
    note TEXT
  ) STRICT;
  CREATE INDEX IF NOT EXISTS memory_fact_events_chat ON memory_fact_events(chat_id, seq);
  CREATE TABLE IF NOT EXISTS memory_derived (
    chat_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    body TEXT NOT NULL,
    input_rev INTEGER NOT NULL,
    generated_at INTEGER NOT NULL,
    PRIMARY KEY(chat_id, kind)
  ) STRICT;`)
}
