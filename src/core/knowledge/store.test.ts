import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openKnowledge, type KnowledgeStore, type SourceMsg, type Chunk } from './store'

function msg(msg_key: string, overrides: Partial<SourceMsg> = {}): SourceMsg {
  return {
    msg_key,
    conversation: 'wxid_alice',
    sender: 'alice',
    time: 1000,
    type: 'text',
    text: `text for ${msg_key}`,
    server_id: 'srv-1',
    local_type: 1,
    is_group: false,
    kind: 'text',
    ...overrides,
  }
}

function chunk(msg_key: string, overrides: Partial<Chunk> = {}): Chunk {
  return {
    msg_key,
    conversation: 'wxid_alice',
    sender: 'alice',
    time: 1000,
    kind: 'text',
    text: `text for ${msg_key}`,
    vector: [0.1, 0.2, 0.3],
    ...overrides,
  }
}

describe('knowledge store', () => {
  let dir: string
  let store: KnowledgeStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kk-store-'))
    store = openKnowledge(dir)
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  describe('source messages', () => {
    it('upserts idempotently on msg_key and pages by watermark', () => {
      const first = store.putSourceMessages([msg('m1'), msg('m2')])
      expect(first.watermark).toBe(2)

      // Re-put m1 — same msg_key must not create a duplicate row.
      const second = store.putSourceMessages([msg('m1', { text: 'updated text' })])
      expect(second.watermark).toBe(3)

      const page1 = store.listMessages(0, 10)
      expect(page1.messages).toHaveLength(2)
      // m1 was re-written last, so it now sorts after m2 by watermark.
      expect(page1.messages.map(m => m.msg_key)).toEqual(['m2', 'm1'])
      expect(page1.messages.find(m => m.msg_key === 'm1')?.text).toBe('updated text')
      expect(page1.watermark).toBe(3)

      const page2 = store.listMessages(page1.watermark, 10)
      expect(page2.messages).toHaveLength(0)
      expect(page2.watermark).toBe(page1.watermark)
    })

    it('caps a page at limit and returns the watermark of the last row in the page', () => {
      store.putSourceMessages([msg('a'), msg('b'), msg('c')])
      const page = store.listMessages(0, 2)
      expect(page.messages.map(m => m.msg_key)).toEqual(['a', 'b'])
      expect(page.watermark).toBe(2)

      const rest = store.listMessages(page.watermark, 10)
      expect(rest.messages.map(m => m.msg_key)).toEqual(['c'])
      expect(rest.watermark).toBe(3)
    })

    it('listMessages on an empty store returns no rows and echoes sinceWatermark', () => {
      const page = store.listMessages(0, 10)
      expect(page.messages).toEqual([])
      expect(page.watermark).toBe(0)
    })

    it('round-trips local_type/is_group/kind', () => {
      store.putSourceMessages([
        msg('m1', { local_type: 1, is_group: false, kind: 'text' }),
        msg('m2', { local_type: 34, is_group: true, kind: 'voice', text: '' }),
        msg('m3', { local_type: 49, is_group: true, kind: 'transfer', text: '' }),
      ])
      const { messages } = store.listMessages(0, 10)
      const byKey = new Map(messages.map(m => [m.msg_key, m]))
      expect(byKey.get('m1')).toMatchObject({ local_type: 1, is_group: false, kind: 'text' })
      expect(byKey.get('m2')).toMatchObject({ local_type: 34, is_group: true, kind: 'voice' })
      expect(byKey.get('m3')).toMatchObject({ local_type: 49, is_group: true, kind: 'transfer' })
      // is_group must round-trip as an actual boolean, not a raw 0/1 integer.
      expect(byKey.get('m1')?.is_group).toBe(false)
      expect(byKey.get('m2')?.is_group).toBe(true)
    })

    it('listMessages(kind: "text") returns only text-kind rows', () => {
      store.putSourceMessages([
        msg('m1', { kind: 'text', text: 'hello' }),
        msg('m2', { kind: 'voice', text: '' }),
        msg('m3', { kind: 'text', text: 'world' }),
        msg('m4', { kind: 'transfer', text: '' }),
      ])
      const { messages, watermark } = store.listMessages(0, 10, 'text')
      expect(messages.map(m => m.msg_key)).toEqual(['m1', 'm3'])
      // watermark is the last matching row's cursor position — a valid
      // resume point since the next call's WHERE ingested_watermark > ?
      // re-filters (cheaply, via the kind index) rather than skipping rows.
      expect(watermark).toBeGreaterThan(0)
    })
  })

  describe('source mentions', () => {
    it('putMentions/mentionsFor round-trips target usernames for a msg_key', () => {
      store.putMentions([
        { msg_key: 'g1:1', target_un: 'wxid_bob' },
        { msg_key: 'g1:1', target_un: 'wxid_carol' },
        { msg_key: 'g1:2', target_un: 'wxid_dave' },
      ])
      expect(store.mentionsFor('g1:1').sort()).toEqual(['wxid_bob', 'wxid_carol'])
      expect(store.mentionsFor('g1:2')).toEqual(['wxid_dave'])
      expect(store.mentionsFor('g1:nonexistent')).toEqual([])
    })

    it('allMentions reads every mention row for the graph builder', () => {
      store.putMentions([
        { msg_key: 'g1:1', target_un: 'wxid_bob' },
        { msg_key: 'g1:2', target_un: 'wxid_dave' },
      ])
      const all = store.allMentions()
      expect(all).toHaveLength(2)
      expect(all).toEqual(
        expect.arrayContaining([
          { msg_key: 'g1:1', target_un: 'wxid_bob' },
          { msg_key: 'g1:2', target_un: 'wxid_dave' },
        ]),
      )
    })

    it('re-putting mentions for the same msg_key replaces rather than duplicates (idempotent re-ingest)', () => {
      store.putMentions([{ msg_key: 'g1:1', target_un: 'wxid_bob' }])
      store.putMentions([{ msg_key: 'g1:1', target_un: 'wxid_carol' }])
      expect(store.mentionsFor('g1:1')).toEqual(['wxid_carol'])
    })
  })

  describe('semantic chunks + provenance', () => {
    it('putSemantic is idempotent on (msg_key, model_id)', () => {
      store.putSemantic('m', '1', [chunk('m1')])
      store.putSemantic('m', '1', [chunk('m1', { text: 'revised' })])
      expect(store.countSemantic('m')).toBe(1)
      const { rowids } = store.loadVectors('m')
      expect(rowids).toHaveLength(1)
      const docs = store.getDocs(rowids)
      expect(docs.get(rowids[0]!)?.text).toBe('revised')
    })

    it('records the active model in meta on every call, last-indexed wins', () => {
      store.putSemantic('model-a', 'v1', [chunk('m1')])
      expect(store.getMeta('embed_model')).toBe('model-a')
      expect(store.getMeta('embed_model_version')).toBe('v1')

      store.putSemantic('model-b', 'v2', [chunk('m2')])
      expect(store.getMeta('embed_model')).toBe('model-b')
      expect(store.getMeta('embed_model_version')).toBe('v2')
    })

    it('loadVectors(model_id) returns only that model\'s vectors, at the right dim', () => {
      store.putSemantic('m', '1', [
        chunk('m1', { vector: [1, 2, 3, 4] }),
        chunk('m2', { vector: [5, 6, 7, 8] }),
      ])
      const { rowids, dim, mat } = store.loadVectors('m')
      expect(dim).toBe(4)
      expect(rowids).toHaveLength(2)
      expect(mat.length).toBe(8)
      expect(Array.from(mat.slice(0, 4))).toEqual([1, 2, 3, 4])
    })

    it('provenance isolation: a chunk written under a different model_id is not returned by loadVectors for this one', () => {
      store.putSemantic('m', '1', [chunk('m1', { vector: [1, 2] })])
      store.putSemantic('m2', '1', [chunk('other', { vector: [9, 9, 9] })])

      const forM = store.loadVectors('m')
      expect(forM.rowids).toHaveLength(1)
      expect(forM.dim).toBe(2)

      const forM2 = store.loadVectors('m2')
      expect(forM2.rowids).toHaveLength(1)
      expect(forM2.dim).toBe(3)
    })

    it('loadVectors on an unknown model_id returns an empty result', () => {
      store.putSemantic('m', '1', [chunk('m1')])
      const empty = store.loadVectors('nonexistent')
      expect(empty.rowids).toEqual([])
      expect(empty.dim).toBe(0)
      expect(empty.mat.length).toBe(0)
    })
  })

  describe('keyword search (FTS)', () => {
    it('finds a seeded word via bm25 over chunks_fts', () => {
      store.putSemantic('m', '1', [
        chunk('m1', { text: 'the quick brown fox jumps over the lazy dog' }),
        chunk('m2', { text: 'completely unrelated content about weather' }),
      ])
      const hits = store.keywordSearch('brown fox', 10)
      expect(hits.length).toBeGreaterThan(0)
      const docs = store.getDocs(hits)
      expect([...docs.values()].some(d => d.text.includes('brown fox'))).toBe(true)
    })

    it('falls back to LIKE for short (<3 char) queries', () => {
      store.putSemantic('m', '1', [chunk('m1', { text: 'ok hi there' })])
      const hits = store.keywordSearch('hi', 10)
      expect(hits.length).toBeGreaterThan(0)
    })
  })

  describe('meta', () => {
    it('getMeta returns null when unset, then round-trips setMeta', () => {
      expect(store.getMeta('embed_model')).toBeNull()
      store.setMeta('embed_model', 'bge-small')
      expect(store.getMeta('embed_model')).toBe('bge-small')
      store.setMeta('embed_model', 'bge-large')
      expect(store.getMeta('embed_model')).toBe('bge-large')
    })
  })

  describe('schema migration (pre-existing source.db from Phase 0/1)', () => {
    it('openKnowledge migrates an old 8-column messages table in place (ADD COLUMN), does not throw, and preserves the pre-existing row', () => {
      const migDir = mkdtempSync(join(tmpdir(), 'kk-store-migrate-'))
      try {
        // Simulate a Phase-0/1 source.db: the old 8-column `messages` table,
        // no local_type/is_group/kind. CREATE TABLE IF NOT EXISTS in
        // openKnowledge is a no-op against this — the migration must ALTER
        // it in place instead.
        const oldDb = new Database(join(migDir, 'source.db'), { create: true })
        oldDb.exec(`
          CREATE TABLE messages (
            msg_key TEXT PRIMARY KEY,
            conversation TEXT, sender TEXT, time INTEGER,
            type TEXT, text TEXT, server_id TEXT,
            ingested_watermark INTEGER
          );
        `)
        oldDb
          .query(
            `INSERT INTO messages(msg_key, conversation, sender, time, type, text, server_id, ingested_watermark)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run('old1', 'wxid_alice', 'alice', 1000, 'text', 'pre-migration row', 'srv-0', 1)
        oldDb.close()

        let migrated: KnowledgeStore | undefined
        expect(() => {
          migrated = openKnowledge(migDir)
        }).not.toThrow()

        // New columns are usable: a fresh write with the new fields round-trips.
        migrated!.putSourceMessages([msg('new1', { kind: 'voice', local_type: 34, is_group: true })])
        const { messages } = migrated!.listMessages(0, 10)
        const byKey = new Map(messages.map(m => [m.msg_key, m]))

        // Pre-existing row survives; its new columns are NULL/undefined (tolerated).
        const old = byKey.get('old1')
        expect(old).toBeDefined()
        expect(old?.text).toBe('pre-migration row')
        expect(old?.kind == null).toBe(true)
        expect(old?.is_group).toBe(false)

        expect(byKey.get('new1')).toMatchObject({ kind: 'voice', local_type: 34, is_group: true })

        migrated!.close()

        // PRAGMA table_info confirms the 3 columns now physically exist.
        const check = new Database(join(migDir, 'source.db'))
        const cols = check.query<{ name: string }, []>('PRAGMA table_info(messages)').all().map(r => r.name)
        check.close()
        expect(cols).toEqual(
          expect.arrayContaining(['local_type', 'is_group', 'kind']),
        )
      } finally {
        rmSync(migDir, { recursive: true, force: true })
      }
    })

    it('openKnowledge does not crash against a pre-existing source.db with no contacts table at all, and putContacts works afterward', () => {
      const migDir = mkdtempSync(join(tmpdir(), 'kk-store-migrate-contacts-'))
      try {
        // Simulate a source.db that predates the `contacts` table entirely
        // (e.g. an even older Phase 0/1 snapshot) — CREATE TABLE IF NOT
        // EXISTS in openKnowledge must add it without touching pre-existing
        // tables/rows.
        const oldDb = new Database(join(migDir, 'source.db'), { create: true })
        oldDb.exec(`
          CREATE TABLE messages (
            msg_key TEXT PRIMARY KEY,
            conversation TEXT, sender TEXT, time INTEGER,
            type TEXT, text TEXT, server_id TEXT,
            ingested_watermark INTEGER
          );
        `)
        oldDb.close()

        let migrated: KnowledgeStore | undefined
        expect(() => {
          migrated = openKnowledge(migDir)
        }).not.toThrow()

        expect(migrated!.allSourceContacts()).toEqual([])
        migrated!.putContacts([{ username: 'wxid_alice', display: 'Alice' }])
        expect(migrated!.allSourceContacts()).toEqual([{ username: 'wxid_alice', display: 'Alice' }])

        migrated!.close()
      } finally {
        rmSync(migDir, { recursive: true, force: true })
      }
    })
  })

  describe('source contacts (source.db-side, GR T4.5 display-name map)', () => {
    it('allSourceContacts is empty on a fresh store', () => {
      expect(store.allSourceContacts()).toEqual([])
    })

    it('putContacts round-trips through allSourceContacts', () => {
      store.putContacts([
        { username: 'wxid_alice', display: 'Alice' },
        { username: 'wxid_bob', display: 'Bob' },
      ])
      const all = store.allSourceContacts()
      expect(all).toHaveLength(2)
      expect(all).toEqual(
        expect.arrayContaining([
          { username: 'wxid_alice', display: 'Alice' },
          { username: 'wxid_bob', display: 'Bob' },
        ]),
      )
    })

    it('putContacts upserts idempotently on username (re-put replaces display, no duplicate rows)', () => {
      store.putContacts([{ username: 'wxid_alice', display: 'Alice' }])
      store.putContacts([{ username: 'wxid_alice', display: 'Alice Updated' }])
      const all = store.allSourceContacts()
      expect(all).toHaveLength(1)
      expect(all[0]).toEqual({ username: 'wxid_alice', display: 'Alice Updated' })
    })

    it('putContacts with an empty array is a no-op, does not throw', () => {
      expect(() => store.putContacts([])).not.toThrow()
      expect(store.allSourceContacts()).toEqual([])
    })
  })

  describe('source meta (source.db-side, for the source-adapter own-DB cursor)', () => {
    it('getSourceMeta returns null when unset, then round-trips setSourceMeta', () => {
      expect(store.getSourceMeta('cursor:foo')).toBeNull()
      store.setSourceMeta('cursor:foo', '10')
      expect(store.getSourceMeta('cursor:foo')).toBe('10')
      store.setSourceMeta('cursor:foo', '20')
      expect(store.getSourceMeta('cursor:foo')).toBe('20')
    })

    it('is a distinct keyspace from getMeta/setMeta (semantic.db meta is a different file)', () => {
      store.setMeta('cursor:foo', 'from-semantic-db')
      store.setSourceMeta('cursor:foo', 'from-source-db')
      expect(store.getMeta('cursor:foo')).toBe('from-semantic-db')
      expect(store.getSourceMeta('cursor:foo')).toBe('from-source-db')
    })
  })
})

function freshStore() {
  return openKnowledge(mkdtempSync(join(tmpdir(), 'kk-facts-')))
}

describe('facts store', () => {
  it('upsertFact inserts then merges on (contact,predicate,value)', () => {
    const s = freshStore()
    const f = {
      contact: 'wxid_a', kind: 'entity', predicate: 'works_at', value: 'Acme',
      confidence: 'low', source_msg_keys: ['Msg_x:1'],
    }
    expect(s.upsertFact(f, 1000).outcome).toBe('inserted')
    // merge: higher confidence wins, msg_keys ordered-union, related/time_ref fill, status untouched
    expect(s.upsertFact({ ...f, confidence: 'high', related_contact: 'wxid_b',
                          time_ref: '2025', source_msg_keys: ['Msg_x:1', 'Msg_y:2'] }, 2000).outcome).toBe('merged')
    const rows = s.factsForContact('wxid_a', 'active')
    expect(rows.length).toBe(1)
    expect(rows[0]!.confidence).toBe('high')                       // max(low,high)
    expect(rows[0]!.source_msg_keys).toEqual(['Msg_x:1', 'Msg_y:2']) // ordered union, no dupes
    expect(rows[0]!.related_contact).toBe('wxid_b')
    expect(rows[0]!.status).toBe('active')
    s.close()
  })

  it('merge does not downgrade confidence and keeps existing related/time_ref', () => {
    const s = freshStore()
    s.upsertFact({ contact: 'c', predicate: 'p', value: 'v', confidence: 'high',
                   related_contact: 'r1', time_ref: 't1', source_msg_keys: ['a:1'] }, 1)
    s.upsertFact({ contact: 'c', predicate: 'p', value: 'v', confidence: 'low',
                   source_msg_keys: ['b:2'] }, 2)                    // lower conf, no related/time_ref
    const r = s.factsForContact('c', 'active')[0]!
    expect(r.confidence).toBe('high')                               // not downgraded
    expect(r.related_contact).toBe('r1')                            // kept
    expect(r.time_ref).toBe('t1')
    expect(r.source_msg_keys).toEqual(['a:1', 'b:2'])
    s.close()
  })

  it('merge treats empty-string related_contact/time_ref/kind as absent (matches Python `or` fill semantics)', () => {
    const s = freshStore()
    s.upsertFact({ contact: 'c', predicate: 'p', value: 'v', kind: 'entity', confidence: 'low',
                   related_contact: 'r1', time_ref: 't1', source_msg_keys: ['a:1'] }, 1)
    s.upsertFact({ contact: 'c', predicate: 'p', value: 'v', kind: '', confidence: 'high',
                   related_contact: '', time_ref: '', source_msg_keys: ['b:2'] }, 2)  // empty strings must NOT clobber
    const r = s.factsForContact('c', 'active')[0]!
    expect(r.related_contact).toBe('r1')
    expect(r.time_ref).toBe('t1')
    expect(r.kind).toBe('entity')
    expect(r.confidence).toBe('high')  // confidence upgrade still applies normally
    s.close()
  })

  it('watermark is monotonic on the (ts, local_id) tuple', () => {
    const s = freshStore()
    expect(s.factWatermark('c')).toEqual([0, 0])
    s.advanceFactWatermark('c', 100, 5, 1)
    expect(s.factWatermark('c')).toEqual([100, 5])
    s.advanceFactWatermark('c', 100, 3, 2)                          // earlier tuple → no regress
    expect(s.factWatermark('c')).toEqual([100, 5])
    s.advanceFactWatermark('c', 100, 9, 3)                          // same ts, later local_id → advance
    expect(s.factWatermark('c')).toEqual([100, 9])
    s.close()
  })

  it('findFactRows filters by kind/predicate/substring/status; setFactStatusById; countsByKind', () => {
    const s = freshStore()
    s.upsertFact({ contact: 'c', kind: 'obligation', predicate: 'owes', value: '200 to Bob',
                   source_msg_keys: [] }, 1)
    s.upsertFact({ contact: 'c', kind: 'entity', predicate: 'likes', value: 'tea', source_msg_keys: [] }, 1)
    expect(s.findFactRows('obligation', null, null, 'active', 50).length).toBe(1)
    expect(s.findFactRows(null, null, 'Bob', 'active', 50).length).toBe(1)   // substring on value
    expect(s.factCountsByKind()).toEqual({ obligation: 1, entity: 1 })
    const id = s.factsForContact('c', 'active').find((r) => r.kind === 'obligation')!.id
    expect(s.setFactStatusById(id, 'resolved', 9)).toBe(true)
    expect(s.findFactRows('obligation', null, null, 'active', 50).length).toBe(0)
    expect(s.findFactRows('obligation', null, null, 'resolved', 50).length).toBe(1)
    s.close()
  })

  describe('temporal validity (2026-08 memory-upgrades)', () => {
    it('insert stamps valid_from = now and returns the row id', () => {
      const s = freshStore()
      const r = s.upsertFact({ contact: 'u1', kind: 'attribute', predicate: '住在', value: '北京' }, 1000)
      expect(r.outcome).toBe('inserted')
      expect(r.id).toBeGreaterThan(0)
      const row = s.factsForContact('u1', 'active')[0]!
      expect(row.id).toBe(r.id)
      expect(row.valid_from).toBe(1000)
      expect(row.invalidated_at).toBeNull()
      expect(row.superseded_by).toBeNull()
      s.close()
    })

    it('merge keeps the original valid_from and returns the existing id', () => {
      const s = freshStore()
      const a = s.upsertFact({ contact: 'u1', predicate: '住在', value: '北京' }, 1000)
      const b = s.upsertFact({ contact: 'u1', predicate: '住在', value: '北京', confidence: 'high' }, 2000)
      expect(b).toEqual({ outcome: 'merged', id: a.id })
      expect(s.factsForContact('u1', 'active')[0]!.valid_from).toBe(1000)
      s.close()
    })

    it('activeFactsSharingPredicate finds same-predicate different-value active facts only', () => {
      const s = freshStore()
      const a = s.upsertFact({ contact: 'u1', kind: 'attribute', predicate: '住在', value: '北京' }, 1000)
      s.upsertFact({ contact: 'u1', kind: 'attribute', predicate: '住在', value: '上海' }, 2000)
      s.upsertFact({ contact: 'u1', kind: 'attribute', predicate: '喜欢', value: '茶' }, 2000)     // other predicate
      s.upsertFact({ contact: 'u2', kind: 'attribute', predicate: '住在', value: '广州' }, 2000)   // other contact
      const hits = s.activeFactsSharingPredicate('u1', '住在', '上海')
      expect(hits.map((h) => h.value)).toEqual(['北京'])
      expect(hits[0]!.id).toBe(a.id)
      s.close()
    })

    it('supersedeFactById flips status + stamps invalidated_at/superseded_by; refuses non-active', () => {
      const s = freshStore()
      const a = s.upsertFact({ contact: 'u1', predicate: '住在', value: '北京' }, 1000)
      const b = s.upsertFact({ contact: 'u1', predicate: '住在', value: '上海' }, 2000)
      expect(s.supersedeFactById(a.id, b.id, 3000)).toBe(true)
      expect(s.factsForContact('u1', 'active').map((f) => f.value)).toEqual(['上海'])
      const dead = s.factsForContact('u1', 'superseded')[0]!
      expect(dead.invalidated_at).toBe(3000)
      expect(dead.superseded_by).toBe(b.id)
      expect(dead.status).toBe('superseded')
      expect(s.supersedeFactById(a.id, b.id, 4000)).toBe(false)  // already superseded — no double stamp
      expect(s.factsForContact('u1', 'superseded')[0]!.invalidated_at).toBe(3000)
      s.close()
    })

    it('conflictedFactGroups finds active same-predicate multi-value groups, newest first', () => {
      const s = freshStore()
      s.upsertFact({ contact: 'u1', predicate: '住在', value: '北京' }, 1000)
      const b = s.upsertFact({ contact: 'u1', predicate: '住在', value: '上海' }, 2000)
      s.upsertFact({ contact: 'u1', predicate: '喜欢', value: '茶' }, 1000)      // single value — not a group
      s.upsertFact({ contact: 'u2', predicate: '工作在', value: 'A公司' }, 1000)
      s.upsertFact({ contact: 'u2', predicate: '工作在', value: 'B公司' }, 3000)
      const groups = s.conflictedFactGroups(10)
      expect(groups).toHaveLength(2)
      const g1 = groups.find((g) => g.contact === 'u1')!
      expect(g1.predicate).toBe('住在')
      expect(g1.facts.map((f) => f.value)).toEqual(['上海', '北京'])   // updated_at DESC
      expect(g1.facts[0]!.id).toBe(b.id)
      expect(s.conflictedFactGroups(1)).toHaveLength(1)                // limit respected
      s.close()
    })

    it('conflictedFactGroups ignores superseded rows', () => {
      const s = freshStore()
      const a = s.upsertFact({ contact: 'u1', predicate: '住在', value: '北京' }, 1000)
      const b = s.upsertFact({ contact: 'u1', predicate: '住在', value: '上海' }, 2000)
      s.supersedeFactById(a.id, b.id, 3000)
      expect(s.conflictedFactGroups(10)).toEqual([])
      s.close()
    })

    it('factById returns the row or null', () => {
      const s = freshStore()
      const a = s.upsertFact({ contact: 'u1', predicate: 'p', value: 'v' }, 1000)
      expect(s.factById(a.id)?.value).toBe('v')
      expect(s.factById(999999)).toBeNull()
      s.close()
    })

    it('reopening a pre-upgrade facts.db adds the columns and backfills valid_from from created_at', () => {
      const migDir = mkdtempSync(join(tmpdir(), 'kk-facts-migrate-'))
      try {
        // Simulate a facts.db created BEFORE the temporal columns existed.
        const legacy = new Database(join(migDir, 'facts.db'), { create: true })
        legacy.exec(`
          CREATE TABLE IF NOT EXISTS facts (
            id INTEGER PRIMARY KEY, contact TEXT, kind TEXT, predicate TEXT, value TEXT,
            related_contact TEXT, time_ref TEXT, confidence TEXT, source_msg_keys TEXT,
            status TEXT, created_at INTEGER, updated_at INTEGER,
            UNIQUE(contact, predicate, value));
          CREATE TABLE IF NOT EXISTS extraction_state (
            contact TEXT PRIMARY KEY, last_ts INTEGER, last_local_id INTEGER DEFAULT 0,
            updated_at INTEGER);`)
        legacy.query(`INSERT INTO facts(contact,kind,predicate,value,related_contact,time_ref,
          confidence,source_msg_keys,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
          .run('u1', 'entity', 'p', 'v', null, null, 'med', '[]', 'active', 777, 777)
        legacy.close()

        const s = openKnowledge(migDir)
        const row = s.factsForContact('u1', 'active')[0]!
        expect(row.valid_from).toBe(777)          // backfilled from created_at
        expect(row.invalidated_at).toBeNull()
        expect(row.superseded_by).toBeNull()
        s.close()
      } finally {
        rmSync(migDir, { recursive: true, force: true })
      }
    })
  })

  it('oneToOneTextMessages excludes groups and non-text; recentMessages is newest-first', () => {
    const s = freshStore()
    s.putSourceMessages([
      { msg_key: 'Msg_a:1', conversation: 'wxid_a', sender: 'wxid_a', time: 10, type: '1',
        text: 'hi', server_id: '1', local_type: 1, is_group: false, kind: 'text' },
      { msg_key: 'Msg_a:2', conversation: 'wxid_a', sender: 'me', time: 20, type: '1',
        text: 'yo', server_id: '2', local_type: 1, is_group: false, kind: 'text' },
      { msg_key: 'Grp_x:1', conversation: 'x@chatroom', sender: 'wxid_a', time: 15, type: '1',
        text: 'grp', server_id: '3', local_type: 1, is_group: true, kind: 'text' },
      { msg_key: 'Msg_a:3', conversation: 'wxid_a', sender: 'wxid_a', time: 30, type: '34',
        text: '', server_id: '4', local_type: 34, is_group: false, kind: 'voice' },
    ])
    const oto = s.oneToOneTextMessages()
    expect(oto.map((m) => m.msg_key).sort()).toEqual(['Msg_a:1', 'Msg_a:2'])  // no group, no voice
    const recent = s.recentMessages('wxid_a', 5)
    expect(recent.map((m) => m.text)).toEqual(['yo', 'hi'])                    // newest-first by time
    s.close()
  })
})

describe('obligation dedup feed', () => {
  it('obligationHeavyContacts lists contacts with ≥2 active obligations, heaviest first', () => {
    const s = freshStore()
    s.upsertFact({ contact: 'u1', kind: 'obligation', predicate: 'a', value: 'v1' }, 1)
    s.upsertFact({ contact: 'u1', kind: 'obligation', predicate: 'b', value: 'v2' }, 2)
    s.upsertFact({ contact: 'u1', kind: 'obligation', predicate: 'c', value: 'v3' }, 3)
    s.upsertFact({ contact: 'u2', kind: 'obligation', predicate: 'd', value: 'v4' }, 4)
    s.upsertFact({ contact: 'u2', kind: 'obligation', predicate: 'e', value: 'v5' }, 5)
    s.upsertFact({ contact: 'u3', kind: 'obligation', predicate: 'f', value: 'v6' }, 6)   // only 1 — excluded
    s.upsertFact({ contact: 'u4', kind: 'entity', predicate: 'g', value: 'v7' }, 7)       // not obligation
    const heavy = s.obligationHeavyContacts(10)
    expect(heavy).toEqual([{ contact: 'u1', n: 3 }, { contact: 'u2', n: 2 }])
    expect(s.obligationHeavyContacts(1)).toHaveLength(1)
    // settlement-backfill feed: minCount=1 includes single-obligation contacts
    expect(s.obligationHeavyContacts(10, 1)).toEqual([
      { contact: 'u1', n: 3 }, { contact: 'u2', n: 2 }, { contact: 'u3', n: 1 },
    ])
    s.close()
  })
})

describe('vector cache (2026-08-24: auto-recall pays a full-matrix disk read per message)', () => {
  it('loadVectors reflects writes made after a cached read (count-based invalidation)', () => {
    const s = freshStore()
    const chunk = (key: string, vec: number[]) => ({ msg_key: key, conversation: 'c', sender: 's', time: 1, kind: 'text', text: 't', vector: vec })
    s.putSemantic('m1', 'v1', [chunk('a:1', [1, 0])])
    expect(s.loadVectors('m1').rowids).toHaveLength(1)
    expect(s.loadVectors('m1').rowids).toHaveLength(1)   // cached path
    s.putSemantic('m1', 'v1', [chunk('a:2', [0, 1])])    // write AFTER cache
    const after = s.loadVectors('m1')
    expect(after.rowids).toHaveLength(2)                  // cache must not serve stale
    expect(after.mat).toHaveLength(4)
    s.close()
  })

  it('cache is per model_id', () => {
    const s = freshStore()
    const chunk = (key: string, vec: number[]) => ({ msg_key: key, conversation: 'c', sender: 's', time: 1, kind: 'text', text: 't', vector: vec })
    s.putSemantic('m1', 'v1', [chunk('a:1', [1, 0])])
    s.putSemantic('m2', 'v1', [chunk('a:1', [1, 0, 0])])
    expect(s.loadVectors('m1').dim).toBe(2)
    expect(s.loadVectors('m2').dim).toBe(3)
    expect(s.loadVectors('m1').dim).toBe(2)
    s.close()
  })
})
