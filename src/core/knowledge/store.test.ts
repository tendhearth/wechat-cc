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
