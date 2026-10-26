import type { Migration } from '../../../../lib/db'

// v1 — facts.db 今天的结构(G1 从 store.ts 原样搬来,幂等)。G7 之后 facts 进主库,这个库只在导入时读一次。
// 时间有效性三列(2026-08)是后加的:缺哪列补哪列;valid_from 只在刚补上时从 created_at 回填一次(那时每行都是 NULL)。
export const migration: Migration = (db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS facts (
      id INTEGER PRIMARY KEY, contact TEXT, kind TEXT, predicate TEXT, value TEXT,
      related_contact TEXT, time_ref TEXT, confidence TEXT, source_msg_keys TEXT,
      status TEXT, created_at INTEGER, updated_at INTEGER,
      UNIQUE(contact, predicate, value));
    CREATE TABLE IF NOT EXISTS extraction_state (
      contact TEXT PRIMARY KEY, last_ts INTEGER, last_local_id INTEGER DEFAULT 0,
      updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS judge_state (
      key TEXT PRIMARY KEY, fingerprint TEXT, judged_at INTEGER);`)
  const cols = new Set(db.query<{ name: string }, []>('PRAGMA table_info(facts)').all().map(c => c.name))
  const hadValidFrom = cols.has('valid_from')
  if (!hadValidFrom) db.exec('ALTER TABLE facts ADD COLUMN valid_from INTEGER')
  if (!cols.has('invalidated_at')) db.exec('ALTER TABLE facts ADD COLUMN invalidated_at INTEGER')
  if (!cols.has('superseded_by')) db.exec('ALTER TABLE facts ADD COLUMN superseded_by INTEGER')
  if (!hadValidFrom) db.exec('UPDATE facts SET valid_from = created_at WHERE valid_from IS NULL')
}
