import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openKnowledge, type KnowledgeStore, type Chunk } from './store'
import { semanticSearch } from './search'

function chunk(msg_key: string, overrides: Partial<Chunk> = {}): Chunk {
  return {
    msg_key,
    conversation: 'wxid_alice',
    sender: 'alice',
    time: 1000,
    kind: 'text',
    text: `text for ${msg_key}`,
    vector: [0, 0, 0],
    ...overrides,
  }
}

describe('semanticSearch', () => {
  let dir: string
  let store: KnowledgeStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kk-search-'))
    store = openKnowledge(dir)

    // Three chunks under model 'm', with distinct unit vectors and distinct texts.
    // A: unrelated vector + text. B: the vector the query will be closest to.
    // C: a text the query text will match via trigram FTS, but a distant vector.
    store.putSemantic('m', '1', [
      chunk('a', { conversation: 'wxid_alice', text: 'nothing special here about weather', vector: [1, 0, 0] }),
      chunk('b', { conversation: 'wxid_alice', text: 'a chunk with no keyword overlap at all', vector: [0, 1, 0] }),
      chunk('c', { conversation: 'wxid_bob', text: 'quokka sighting near the river', vector: [0, 0, 1] }),
    ])
    store.setMeta('embed_model', 'm')
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('fuses cosine-nearest and bm25-matching chunks via RRF', () => {
    // Query vector closest to chunk B ([0,1,0]); query text matches chunk C's word "quokka".
    const { vectors_stale, results } = semanticSearch(store, {
      queryVector: [0, 1, 0],
      queryText: 'quokka',
      model_id: 'm',
      limit: 10,
    })

    expect(vectors_stale).toBe(false)
    const msgKeys = results.map(r => r.text)
    expect(results.some(r => r.text.includes('no keyword overlap'))).toBe(true) // B, via cosine
    expect(results.some(r => r.text.includes('quokka'))).toBe(true) // C, via bm25
    void msgKeys
  })

  it('sets vectors_stale and skips cosine when model_id differs from the indexed model', () => {
    const { vectors_stale, results } = semanticSearch(store, {
      queryVector: [0, 1, 0],
      queryText: 'quokka',
      model_id: 'different-model',
      limit: 10,
    })

    expect(vectors_stale).toBe(true)
    // BM25-only: chunk B (no keyword overlap with "quokka") must not appear.
    expect(results.every(r => !r.text.includes('no keyword overlap'))).toBe(true)
    expect(results.some(r => r.text.includes('quokka'))).toBe(true)
  })

  it('applies the conversation filter after fusion', () => {
    const { results } = semanticSearch(store, {
      queryVector: [0, 1, 0],
      queryText: 'quokka',
      model_id: 'm',
      limit: 10,
      conversation: 'wxid_alice',
    })

    expect(results.length).toBeGreaterThan(0)
    expect(results.every(r => r.conversation === 'wxid_alice')).toBe(true)
    // chunk C lives under wxid_bob — must be dropped by the filter.
    expect(results.every(r => !r.text.includes('quokka'))).toBe(true)
  })

  it('skips cosine (no crash) when queryVector length does not match the stored dim', () => {
    const { vectors_stale, results } = semanticSearch(store, {
      queryVector: [0, 1, 0, 0], // stored vectors are dim 3
      queryText: 'quokka',
      model_id: 'm',
      limit: 10,
    })

    // Still the correct model — not stale by the meta check.
    expect(vectors_stale).toBe(false)
    // But cosine was skipped: BM25-only results, so chunk B must not appear.
    expect(results.every(r => !r.text.includes('no keyword overlap'))).toBe(true)
    expect(results.some(r => r.text.includes('quokka'))).toBe(true)
  })
})
