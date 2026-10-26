/**
 * G7:knowledge/facts.db → 主库(设计稿 docs/superpowers/specs/2026-10-25-memory-single-source-design.md §3「数据怎么搬」第 2 条)。
 * facts.db 是合成的(夹具 src/test-support/fixtures/memory/facts.json 的那几行)。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openTestDb, type Db } from '../../lib/db'
import { openSqlite } from '../../lib/runtime/sqlite'
import { removeTempDir } from '../../lib/test-temp'
import { makeMemoryFactsStore } from '../../adapters/store/memory-facts'
import { migrations as factsMigrations } from '../../adapters/knowledge/migrations/facts'
import type { MemoryFactsStore } from '../../ports/memory-facts'
import { importFactsDb } from './facts-import'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test-support', 'fixtures', 'memory')
const fixture = JSON.parse(readFileSync(join(FIXTURES, 'facts.json'), 'utf8')) as { facts: Array<Record<string, any>> }

let root = '', db: Db, store: MemoryFactsStore
const now = 1_761_400_000_000
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'facts-import-')); db = openTestDb(); store = makeMemoryFactsStore(db) })
afterEach(() => { db.close(); removeTempDir(root) })

function legacyFactsDb(opts: { oldShape?: boolean } = {}) {
  const f = openSqlite(join(root, 'facts.db'))
  if (opts.oldShape) f.exec(`CREATE TABLE facts (id INTEGER PRIMARY KEY, contact TEXT, kind TEXT, predicate TEXT, value TEXT, related_contact TEXT, time_ref TEXT,
    confidence TEXT, source_msg_keys TEXT, status TEXT, created_at INTEGER, updated_at INTEGER, UNIQUE(contact, predicate, value));
    CREATE TABLE extraction_state (contact TEXT PRIMARY KEY, last_ts INTEGER, last_local_id INTEGER DEFAULT 0, updated_at INTEGER);
    CREATE TABLE judge_state (key TEXT PRIMARY KEY, fingerprint TEXT, judged_at INTEGER);`)
  else factsMigrations[0]!(f)
  for (const r of fixture.facts) {
    if (opts.oldShape) f.query('INSERT INTO facts(id, contact, kind, predicate, value, related_contact, time_ref, confidence, source_msg_keys, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(r.id, r.contact, r.kind, r.predicate, r.value, r.related_contact, r.time_ref, r.confidence, JSON.stringify(r.source_msg_keys), r.status, r.created_at, r.updated_at)
    else f.query('INSERT INTO facts(id, contact, kind, predicate, value, related_contact, time_ref, confidence, source_msg_keys, status, created_at, updated_at, valid_from, invalidated_at, superseded_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(r.id, r.contact, r.kind, r.predicate, r.value, r.related_contact, r.time_ref, r.confidence, JSON.stringify(r.source_msg_keys), r.status, r.created_at, r.updated_at, r.valid_from, r.invalidated_at, r.superseded_by)
  }
  f.exec("INSERT INTO extraction_state(contact, last_ts, last_local_id, updated_at) VALUES ('wxid_fx_lin', 1760900000, 42, 1760900001)")
  f.exec("INSERT INTO judge_state(key, fingerprint, judged_at) VALUES ('settle:wxid_fx_mom', '2|7,9', 1760850001)")
  return f
}
const run = () => importFactsDb({ store, knowledgeRoot: root, now: () => now, log: () => {} })

describe('importFactsDb', () => {
  it('copies every row with the same id, status and timestamps; rejected / superseded get their events', () => {
    legacyFactsDb().close()
    expect(run()).toMatchObject({ outcome: 'imported', first: true, inserted: fixture.facts.length })
    for (const r of fixture.facts) {
      const got = store.contactFacts.factById(r.id)!
      expect(got).toMatchObject({ id: r.id, contact: r.contact, kind: r.kind, predicate: r.predicate, value: r.value, status: r.status, created_at: r.created_at, updated_at: r.updated_at, valid_from: r.valid_from, superseded_by: r.superseded_by, source_msg_keys: r.source_msg_keys })
    }
    expect(store.contactFacts.findFactRows('obligation', null, null, 'rejected', 10).map(r => r.id)).toEqual([4])
    const ev = store.events('')
    expect(ev.filter(e => e.action === 'retracted').length).toBe(1)
    expect(ev.filter(e => e.action === 'superseded').length).toBe(1)
    expect(store.contactFacts.factWatermark('wxid_fx_lin')).toEqual([1760900000, 42])
    expect(store.contactFacts.judgeFingerprint('settle:wxid_fx_mom')).toBe('2|7,9')
    // 新事实从最大的原 id 往后编
    expect(store.contactFacts.upsertFact({ contact: 'wxid_fx_lin', kind: 'obligation', predicate: '答应', value: '新的一件事' }, 1761000000)).toEqual({ outcome: 'inserted', id: 8 })
  })

  it('facts.db is only read: never deleted, never renamed; a consistent copy *.imported-<day> is kept once; a second run does nothing', () => {
    legacyFactsDb().close()
    const before = readFileSync(join(root, 'facts.db'))
    run()
    const n = store.events('').length
    expect(run()).toEqual({ outcome: 'unchanged' })
    expect(store.events('').length).toBe(n)
    expect(readFileSync(join(root, 'facts.db')).equals(before)).toBe(true)
    const copy = join(root, `facts.db.imported-${new Date(now).toISOString().slice(0, 10)}`)
    expect(existsSync(copy)).toBe(true)
    const c = openSqlite(copy, { readonly: true })
    expect((c.query('SELECT COUNT(*) AS n FROM facts').get() as { n: number }).n).toBe(fixture.facts.length)
    c.close()
  })

  it('an old-shape facts.db (before temporal validity) imports with valid_from = created_at', () => {
    legacyFactsDb({ oldShape: true }).close()
    expect(run()).toMatchObject({ outcome: 'imported' })
    expect(store.contactFacts.factById(7)!.valid_from).toBe(1760300000)
    expect(store.contactFacts.factById(5)!.superseded_by).toBeNull()
  })

  it('after a rollback the old binary wrote facts.db again ⇒ next boot re-syncs: new rows in, newer rows updated, nothing deleted', () => {
    const f = legacyFactsDb()
    run()
    f.exec("UPDATE facts SET status = 'resolved', updated_at = 1761500000 WHERE id = 1")
    f.exec("INSERT INTO facts(id, contact, kind, predicate, value, confidence, source_msg_keys, status, created_at, updated_at, valid_from) VALUES (20, 'wxid_fx_qing', 'obligation', '答应阿青', '寄豆子', 'med', '[]', 'active', 1761500000, 1761500000, 1761500000)")
    f.close()
    expect(run()).toMatchObject({ outcome: 'imported', first: false, inserted: 1, updated: 1 })
    expect(store.contactFacts.factById(1)!.status).toBe('resolved')
    expect(store.contactFacts.factById(20)!.value).toBe('寄豆子')
    expect(store.contactFacts.factById(2)!.status).toBe('active')
  })

  it('a row that cannot go in rolls the whole import back and leaves the table as it was', () => {
    // 新二进制已经记了同一句(id 不同):facts.db 那一行插不进去 ⇒ 不搬、下次再试
    store.contactFacts.upsertFact({ contact: 'wxid_fx_lin', kind: 'obligation', predicate: '答应帮小林', value: '看一下他的简历' }, 1)
    legacyFactsDb().close()
    expect(run()).toMatchObject({ outcome: 'mismatch' })
    expect(store.contactFacts.factById(2)).toBeNull()
    expect(store.importHash('__facts.db__')).toBeNull()
  })

  it('no facts.db ⇒ nothing to do', () => {
    expect(run()).toEqual({ outcome: 'none' })
  })
})
