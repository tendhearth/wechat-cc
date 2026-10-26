/**
 * 知识库四个库进迁移框架(架构终态 G1)的升级路径。
 *
 * G1 之前这些库从来没有 `user_version`(一直是 0),表结构由 store.ts 每次打开时 `CREATE TABLE IF NOT EXISTS` + 守着的 `ALTER`
 * 建出来。所以「上一版」就是两种形状:① 今天 store.ts 建出来的结构(= v001 本身)、② 更早版本留在真机上的旧形状
 * (source.db 的 8 列 messages、缺列的 graph contacts、没有时间有效性三列的 facts)。②是真机上出现过的怪形状,按
 * docs/maintainer/migrations.md 的例外手写那一处,其余照真的建。
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSqlite, type SqlDatabase } from '../../lib/runtime/sqlite'
import { runMigrations, type Migration } from '../../lib/db'
import { removeTempDir } from '../../lib/test-temp'
import { migrations as source } from './migrations/source'
import { migrations as semantic } from './migrations/semantic'
import { migrations as graph } from './migrations/graph'
import { migrations as facts } from './migrations/facts'
import { openKnowledge } from './store'

const LIBS: Array<[string, readonly Migration[]]> = [['source', source], ['semantic', semantic], ['graph', graph], ['facts', facts]]

const version = (db: SqlDatabase) => (db.query('PRAGMA user_version').get() as { user_version: number }).user_version
/** 结构指纹:每张表 / 索引的名字 + 每张表的列(名、类型)。ALTER 补的列在 sqlite_master 的建表文本里写法不同,只比列。 */
function shape(db: SqlDatabase): unknown {
  const objects = db.query<{ type: string; name: string }, []>(
    "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE 'chunks_fts_%' ORDER BY type, name",
  ).all()
  return objects.map(o => o.type === 'table'
    ? { ...o, cols: db.query<{ name: string; type: string }, []>(`PRAGMA table_info(${o.name})`).all().map(c => `${c.name}:${c.type}`).sort() }
    : o)
}
function fresh(list: readonly Migration[]): SqlDatabase {
  const db = openSqlite(':memory:')
  runMigrations(db, list)
  return db
}

describe.each(LIBS)('knowledge %s.db migrations', (_lib, list) => {
  it('from 0 on an empty file: runs every migration, user_version = list length', () => {
    const db = fresh(list)
    expect(version(db)).toBe(list.length)
    expect((shape(db) as unknown[]).length).toBeGreaterThan(0)
  })

  it('already today\'s structure at user_version 0 (every install before G1): v001 changes nothing, rows survive', () => {
    const db = openSqlite(':memory:')
    list[0]!(db)                         // 今天 store.ts 建出来的样子 —— 就是 v001
    expect(version(db)).toBe(0)
    const before = shape(db)
    runMigrations(db, list)
    expect(version(db)).toBe(list.length)
    expect(shape(db)).toEqual(before)
    runMigrations(db, list)              // 再开一次:什么都不跑
    expect(version(db)).toBe(list.length)
  })
})

describe('older shapes left on real machines upgrade to today\'s structure', () => {
  it('source.db: the Phase 0/1 8-column messages table gets local_type / is_group / kind and its index', () => {
    const db = openSqlite(':memory:')
    db.exec(`CREATE TABLE messages (msg_key TEXT PRIMARY KEY, conversation TEXT, sender TEXT, time INTEGER,
      type TEXT, text TEXT, server_id TEXT, ingested_watermark INTEGER);
      INSERT INTO messages VALUES ('k1', 'c', 's', 1, 'text', 'hi', 'sv', 7);`)
    runMigrations(db, source)
    expect(shape(db)).toEqual(shape(fresh(source)))
    expect(db.query('SELECT msg_key, text, ingested_watermark, kind FROM messages').all()).toEqual([{ msg_key: 'k1', text: 'hi', ingested_watermark: 7, kind: null }])
  })

  it('graph.db: a contacts table missing the score columns gets them, rows kept', () => {
    const db = openSqlite(':memory:')
    db.exec(`CREATE TABLE contacts (username TEXT PRIMARY KEY, display TEXT, total INTEGER);
      INSERT INTO contacts VALUES ('u1', '小林', 3);`)
    runMigrations(db, graph)
    expect(shape(db)).toEqual(shape(fresh(graph)))
    expect(db.query('SELECT username, display, total, closeness FROM contacts').all()).toEqual([{ username: 'u1', display: '小林', total: 3, closeness: null }])
  })

  it('facts.db: a facts table from before temporal validity gets the three columns, valid_from backfilled once from created_at', () => {
    const db = openSqlite(':memory:')
    db.exec(`CREATE TABLE facts (
      id INTEGER PRIMARY KEY, contact TEXT, kind TEXT, predicate TEXT, value TEXT,
      related_contact TEXT, time_ref TEXT, confidence TEXT, source_msg_keys TEXT,
      status TEXT, created_at INTEGER, updated_at INTEGER,
      UNIQUE(contact, predicate, value));
      INSERT INTO facts(id, contact, predicate, value, status, created_at, updated_at) VALUES (1, 'u1', 'p', 'v', 'active', 100, 200);`)
    runMigrations(db, facts)
    expect(shape(db)).toEqual(shape(fresh(facts)))
    expect(db.query('SELECT id, valid_from, invalidated_at, superseded_by FROM facts').all()).toEqual([{ id: 1, valid_from: 100, invalidated_at: null, superseded_by: null }])
  })

  it('openKnowledge on a pre-G1 directory stamps all four files and keeps their rows', () => {
    const root = mkdtempSync(join(tmpdir(), 'knowledge-g1-'))
    try {
      for (const [lib, list] of LIBS) {
        const db = openSqlite(join(root, `${lib}.db`))
        list[0]!(db)                     // G1 之前的 store.ts 建的就是这个结构,user_version 0
        db.close()
      }
      const pre = openSqlite(join(root, 'facts.db'))
      pre.exec(`INSERT INTO facts(id, contact, kind, predicate, value, confidence, source_msg_keys, status, created_at, updated_at, valid_from)
        VALUES (5, 'u1', 'obligation', '答应', '回电话', 'med', '[]', 'active', 1, 1, 1)`)
      pre.close()
      const store = openKnowledge(root)
      expect(store.factById(5)?.value).toBe('回电话')
      for (const [lib, list] of LIBS) {
        const db = openSqlite(join(root, `${lib}.db`))
        expect(version(db), lib).toBe(list.length)
        db.close()
      }
    } finally {
      removeTempDir(root)
    }
  })
})
