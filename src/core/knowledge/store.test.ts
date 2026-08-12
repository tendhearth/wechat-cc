import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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
})
