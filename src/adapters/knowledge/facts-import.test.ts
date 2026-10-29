/**
 * G7:knowledge/facts.db → 主库(设计稿 docs/superpowers/specs/2026-10-25-memory-single-source-design.md §3「数据怎么搬」第 2 条)。
 * facts.db 是合成的(夹具 src/test-support/fixtures/memory/facts.json 的那几行)。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
const archiveDir = () => join(root, 'archive')
const run = (log: (tag: string, line: string) => void = () => {}) => importFactsDb({ store, knowledgeRoot: root, archiveDir: archiveDir(), now: () => now, log })

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
    const day = new Date(now).toISOString().slice(0, 10)
    const copy = join(archiveDir(), `facts.db.imported-${day}`)
    expect(existsSync(copy)).toBe(true)
    expect(existsSync(join(root, `facts.db.imported-${day}`))).toBe(false)
    const c = openSqlite(copy, { readonly: true })
    expect((c.query('SELECT COUNT(*) AS n FROM facts').get() as { n: number }).n).toBe(fixture.facts.length)
    c.close()
  })

  it('a copy a 1.7.8 boot left in knowledge/ is moved into the archive dir (never deleted), even when facts.db is unchanged; a name already there is left alone', () => {
    legacyFactsDb().close()
    run()
    writeFileSync(join(root, 'facts.db.imported-2026-10-27'), 'old copy')
    writeFileSync(join(root, 'facts.db.imported-2026-10-26'), 'older copy')
    writeFileSync(join(archiveDir(), 'facts.db.imported-2026-10-26'), 'already archived')
    writeFileSync(join(root, 'semantic.db.imported-2026-10-27'), 'not ours')
    const lines: string[] = []
    expect(run((_t, l) => lines.push(l))).toEqual({ outcome: 'unchanged' })
    expect(readFileSync(join(archiveDir(), 'facts.db.imported-2026-10-27'), 'utf8')).toBe('old copy')
    expect(existsSync(join(root, 'facts.db.imported-2026-10-27'))).toBe(false)
    expect(readFileSync(join(root, 'facts.db.imported-2026-10-26'), 'utf8')).toBe('older copy')
    expect(readFileSync(join(archiveDir(), 'facts.db.imported-2026-10-26'), 'utf8')).toBe('already archived')
    expect(lines.some(l => l.includes('facts.db.imported-2026-10-26') && l.includes('left both'))).toBe(true)
    expect(existsSync(join(root, 'semantic.db.imported-2026-10-27'))).toBe(true)
    expect(existsSync(join(root, 'facts.db'))).toBe(true)
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

  // ── 数据安全评审 G7 第 1 条:一行坏行不卡住整库;id 不撞 ──
  const rawInsert = (f: ReturnType<typeof openSqlite>, r: Record<string, unknown>) =>
    f.query('INSERT INTO facts(id, contact, kind, predicate, value, confidence, source_msg_keys, status, created_at, updated_at, valid_from) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(...(['id', 'contact', 'kind', 'predicate', 'value', 'confidence', 'source_msg_keys', 'status', 'created_at', 'updated_at', 'valid_from'].map(k => (r[k] ?? null) as never)))
  const base = { kind: 'obligation', confidence: 'med', source_msg_keys: '[]', status: 'active', created_at: 1761100000, updated_at: 1761100000, valid_from: 1761100000 }

  it('a free-form status (MCP used to take anything) ⇒ active, with an event that keeps the original value; the rest still imports', () => {
    const f = legacyFactsDb()
    rawInsert(f, { ...base, id: 30, contact: 'wxid_fx_qing', predicate: '答应阿青', value: '还她伞', status: 'dismissed' })
    f.close()
    expect(run()).toMatchObject({ outcome: 'imported', inserted: fixture.facts.length + 1 })
    expect(store.contactFacts.factById(30)).toMatchObject({ status: 'active', value: '还她伞' })
    expect(store.events('').some(e => e.action === 'added' && (e.note ?? '').includes('original status "dismissed"'))).toBe(true)
  })

  it('NULL contact / predicate / value ⇒ that row is skipped and logged; NULL timestamps fall back; nothing else is held up', () => {
    const f = legacyFactsDb()
    rawInsert(f, { ...base, id: 31, contact: null, predicate: '答应', value: '没有主人的一句' })
    rawInsert(f, { ...base, id: 32, contact: 'wxid_fx_lin', predicate: '答应小林', value: null })
    rawInsert(f, { ...base, id: 33, contact: 'wxid_fx_lin', predicate: '答应小林', value: '借他相机', created_at: null, updated_at: 1761200000, confidence: null, status: null })
    f.close()
    const lines: string[] = []
    expect(run((_t, l) => lines.push(l))).toMatchObject({ outcome: 'imported', skipped: 2, inserted: fixture.facts.length + 1 })
    expect(store.contactFacts.factById(31)).toBeNull()
    expect(store.contactFacts.factById(32)).toBeNull()
    expect(store.contactFacts.factById(33)).toMatchObject({ status: 'active', confidence: 'med', created_at: 1761200000, updated_at: 1761200000 })
    expect(lines.filter(l => l.startsWith('skipped')).length).toBe(2)
  })

  it('source_msg_keys that is not valid JSON ⇒ empty list plus a note; REAL numbers ⇒ integers', () => {
    const f = legacyFactsDb()
    rawInsert(f, { ...base, id: 34, contact: 'wxid_fx_mom', predicate: '答应妈妈', value: '打电话', source_msg_keys: '[oops' })
    rawInsert(f, { ...base, id: 35, contact: 'wxid_fx_mom', predicate: '答应妈妈', value: '买药', created_at: 1761100000.7, updated_at: 1761100001.2, valid_from: 1761100000.5 })
    f.close()
    expect(run()).toMatchObject({ outcome: 'imported' })
    expect(store.contactFacts.factById(34)!.source_msg_keys).toEqual([])
    expect(store.events('').some(e => (e.note ?? '').includes('not valid JSON'))).toBe(true)
    expect(store.contactFacts.factById(35)).toMatchObject({ created_at: 1761100000, updated_at: 1761100001, valid_from: 1761100000 })
    expect(db.query("SELECT typeof(created_at) AS t FROM memory_facts WHERE key = 'k:35'").get()).toEqual({ t: 'integer' })
  })

  it('extraction running before a retried import never takes an old id, and the retry loses nothing', () => {
    const f = legacyFactsDb()
    // 最坏的现场:导入一次都没跑成(比如上次开机读 facts.db 就失败了、下限没抬),抽取先记了一句 ⇒ 它拿到 k:1,
    // 正好是 facts.db 1 号的 id;而且这句话和 facts.db 的 2 号是同一件事
    store.contactFacts.upsertFact({ contact: 'wxid_fx_mom', kind: 'obligation', predicate: '答应妈妈', value: '寄回老照片' }, 1760999999)
    expect(store.contactFacts.factById(1)).toMatchObject({ value: '寄回老照片' })
    f.close()
    const first = run()
    // 表里那一句(k:1)和 facts.db 的 2 号是同一件事,表里更新 ⇒ 不动;facts.db 的 1 号被占了 ⇒ 换新 id
    expect(first).toMatchObject({ outcome: 'imported', reassigned: 1 })
    const moved = store.contactFactByText('wxid_fx_lin', '答应帮小林', '看一下他的简历')!
    expect(moved.id).toBeGreaterThan(7)
    expect(store.events('').some(e => (e.note ?? '').includes('id 1 was taken by another fact'))).toBe(true)
    // 之后抽取新记的事实从 max(主库, facts.db)+1 往后编
    expect(store.contactFacts.upsertFact({ contact: 'wxid_fx_lin', kind: 'obligation', predicate: '答应', value: '再一件' }, 1761000000).id).toBe(moved.id + 1)
    // 每一句都还在
    for (const r of fixture.facts) expect(store.contactFactByText(r.contact, r.predicate, r.value)).not.toBeNull()
  })

  it('an import that does not check out leaves the id floor raised, so extraction before the retry cannot collide', () => {
    const f = legacyFactsDb()
    f.close()
    // 让核对不过:表里先有一句同样的话、时间和 facts.db 一样但字段不同(不是这次导入写的)
    const r2 = fixture.facts.find(r => r.id === 2)!
    store.raiseContactIdFloor(0)
    db.query(`INSERT INTO memory_facts(chat_id, key, doc, subject, ord, kind, predicate, confidence, text, status, source, scope, evidence, created_at, updated_at)
      VALUES ('', 'k:50', 'contact', ?, 0, 'obligation', ?, 'high', ?, 'active', 'extract', 'chat', '[]', ?, ?)`).run(r2.contact, r2.predicate, r2.value, r2.created_at, r2.updated_at)
    expect(run()).toMatchObject({ outcome: 'mismatch' })
    expect(store.importHash('__facts.db__')).toBeNull()
    expect(store.contactIdFloor()).toBe(7)
    expect(store.contactFacts.upsertFact({ contact: 'wxid_fx_qing', kind: 'obligation', predicate: '答应阿青', value: '新的' }, 1761000000).id).toBe(51)
    // 下一次重试:已经进表的不重复进
    const before = (db.query("SELECT COUNT(*) AS n FROM memory_facts WHERE doc = 'contact'").get() as { n: number }).n
    run()
    expect((db.query("SELECT COUNT(*) AS n FROM memory_facts WHERE doc = 'contact'").get() as { n: number }).n).toBe(before)
  })

  // ── 数据安全评审 G7 第 2 条:回滚后老二进制用 max(rowid)+1 编的号,可能是新二进制已经用过的 ──
  it('a rollback collision: the old binary reuses an id the new binary already gave to another fact ⇒ both facts survive, logged', () => {
    const f = legacyFactsDb()
    run()
    const mine = store.contactFacts.upsertFact({ contact: 'wxid_fx_lin', kind: 'obligation', predicate: '答应小林', value: '周五一起吃饭' }, 1761300000)
    expect(mine.id).toBe(8)
    // 回滚:老二进制在 facts.db 里新记一条,max(rowid)+1 = 8,还比主库那条新
    rawInsert(f, { ...base, id: 8, contact: 'wxid_fx_mom', predicate: '答应妈妈', value: '国庆回家', created_at: 1761400000, updated_at: 1761400000, valid_from: 1761400000 })
    f.close()
    const lines: string[] = []
    expect(run((_t, l) => lines.push(l))).toMatchObject({ outcome: 'imported', reassigned: 1 })
    expect(store.contactFacts.factById(8)).toMatchObject({ contact: 'wxid_fx_lin', value: '周五一起吃饭' })   // 没被盖掉
    const theirs = store.contactFactByText('wxid_fx_mom', '答应妈妈', '国庆回家')!
    expect(theirs.id).toBeGreaterThan(8)
    expect(lines.some(l => l.includes('fact 8 collided'))).toBe(true)
    // 再开机一次:不会再插一份
    expect(run()).toEqual({ outcome: 'unchanged' })
  })

  it('a newer updated_at on the same id but different words is not the same fact (no overwrite of text without subject)', () => {
    const f = legacyFactsDb()
    run()
    f.exec("UPDATE facts SET value = '看一下他的作品集', updated_at = 1761500000 WHERE id = 1")
    f.close()
    expect(run()).toMatchObject({ outcome: 'imported', reassigned: 1 })
    expect(store.contactFacts.factById(1)!.value).toBe('看一下他的简历')
    expect(store.contactFactByText('wxid_fx_lin', '答应帮小林', '看一下他的作品集')).not.toBeNull()
  })

  it('no facts.db ⇒ nothing to do', () => {
    expect(run()).toEqual({ outcome: 'none' })
  })
})
