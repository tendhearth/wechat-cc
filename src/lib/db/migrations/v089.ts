import type { Migration } from './types'

// v89 — 联系人事实进主库(架构终态 G7,设计稿 docs/superpowers/specs/2026-10-25-memory-single-source-design.md §3):
// 事实本身是 memory_facts 里 doc = 'contact' 的行(key = 'k:<facts.db 原 id>',对外的 id 不变);这里补两样:
//  - 同一个联系人的同一句(subject, predicate, text)只许一行 —— facts.db 的 UNIQUE(contact, predicate, value),只管联系人事实;
//  - 抽取水位与判官指纹两张小表(facts.db 的 extraction_state / judge_state,名字加 knowledge_ 前缀)。
// facts.db 本身不动:开机导入一次(只复制,不删、不改名),之后不再写它。建表带 IF NOT EXISTS(#79 的修复会重放后面的迁移)。
export const migration: Migration = (db) => {
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS memory_facts_contact_unique ON memory_facts(subject, predicate, text) WHERE doc = 'contact';
  CREATE INDEX IF NOT EXISTS memory_facts_contact_kind ON memory_facts(doc, kind, status, updated_at);
  CREATE TABLE IF NOT EXISTS knowledge_extraction_state (
    contact TEXT PRIMARY KEY NOT NULL,
    last_ts INTEGER NOT NULL,
    last_local_id INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS knowledge_judge_state (
    key TEXT PRIMARY KEY NOT NULL,
    fingerprint TEXT,
    judged_at INTEGER NOT NULL
  ) STRICT;`)
}
