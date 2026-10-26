import type { Migration } from '../../../../lib/db'

// v1 — graph.db 今天的结构(G1 从 store.ts 原样搬来,幂等)。contacts 表若是更早的版本建的(缺这一版要的列),缺哪列补哪列。
const CONTACT_COL_TYPES: Record<string, string> = {
  display: 'TEXT', is_group: 'INTEGER', total: 'INTEGER', sent: 'INTEGER', recv: 'INTEGER',
  first_ts: 'INTEGER', last_ts: 'INTEGER', known_days: 'INTEGER', active_days: 'INTEGER',
  initiations: 'INTEGER', transfer_in: 'INTEGER', transfer_out: 'INTEGER', shared_groups: 'INTEGER',
  types: 'TEXT', s_volume: 'REAL', s_recency: 'REAL', s_reciprocity: 'REAL', s_intimacy: 'REAL', closeness: 'REAL',
}

export const migration: Migration = (db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      username TEXT PRIMARY KEY, display TEXT, is_group INTEGER, total INTEGER, sent INTEGER,
      recv INTEGER, first_ts INTEGER, last_ts INTEGER, known_days INTEGER, active_days INTEGER,
      initiations INTEGER, transfer_in INTEGER, transfer_out INTEGER, shared_groups INTEGER,
      types TEXT, s_volume REAL, s_recency REAL, s_reciprocity REAL, s_intimacy REAL, closeness REAL
    );
    CREATE TABLE IF NOT EXISTS edges (a TEXT, b TEXT, kind TEXT, weight REAL, PRIMARY KEY(a, b, kind));
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  `)
  const existing = new Set(db.query<{ name: string }, []>('PRAGMA table_info(contacts)').all().map(r => r.name))
  for (const [col, ddlType] of Object.entries(CONTACT_COL_TYPES)) {
    if (!existing.has(col)) db.exec(`ALTER TABLE contacts ADD COLUMN ${col} ${ddlType}`)
  }
}
