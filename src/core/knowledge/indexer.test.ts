// src/core/knowledge/indexer.test.ts
//
// Knowledge Kernel Task 6' — runIndexer is the daemon-driven, in-process
// indexer: it pages `source` via the store, embeds via an INJECTED `embed`
// function (no subprocess/HTTP knowledge here — that's embed-runner.ts's
// job), and writes `semantic` via the store. Resume is via a store meta
// cursor keyed by model_id, so a second run against an unchanged source is
// a no-op.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runIndexer } from './indexer'
import { openKnowledge, type KnowledgeStore, type SourceMsg } from './store'

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

/** Deterministic fake embed: one fixed-dim vector per input text (dim 3,
 *  derived from text length so distinct texts get distinct-but-stable
 *  vectors — doesn't matter for this test, just needs to be fixed-dim). */
function fakeEmbed(texts: string[]): Promise<number[][]> {
  return Promise.resolve(texts.map(t => [t.length, 1, 2]))
}

describe('runIndexer', () => {
  let dir: string
  let store: KnowledgeStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kk-indexer-'))
    store = openKnowledge(dir)
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('indexes all source messages into semantic under model_id, skipping empty text', async () => {
    store.putSourceMessages([
      msg('m1'),
      msg('m2', { text: '' }), // empty text — must be skipped
      msg('m3'),
    ])

    const result = await runIndexer({
      store,
      embed: fakeEmbed,
      model_id: 'test-model',
      model_version: 'v1',
    })

    expect(result.indexed).toBe(2)
    expect(store.countSemantic('test-model')).toBe(2)

    const { rowids } = store.loadVectors('test-model')
    expect(rowids).toHaveLength(2)
    const docs = store.getDocs(rowids)
    const texts = Array.from(docs.values()).map(d => d.text).sort()
    expect(texts).toEqual(['text for m1', 'text for m3'])
  })

  it('does not embed non-text kinds (Knowledge Graph inproc Task 1: source now holds every message kind)', async () => {
    store.putSourceMessages([
      msg('m1'),
      msg('m2', { kind: 'voice', local_type: 34, text: '', type: 'voice' }),
      msg('m3', { kind: 'transfer', local_type: 49, text: '', type: 'transfer' }),
      msg('m4', { kind: 'text', is_group: true, text: 'group text' }),
    ])

    const result = await runIndexer({
      store,
      embed: fakeEmbed,
      model_id: 'test-model',
      model_version: 'v1',
    })

    // Only the two text-kind rows are embedded — voice/transfer are ingested
    // into source but never reach the embedder.
    expect(result.indexed).toBe(2)
    expect(store.countSemantic('test-model')).toBe(2)
    const { rowids } = store.loadVectors('test-model')
    const docs = store.getDocs(rowids)
    const texts = Array.from(docs.values()).map(d => d.text).sort()
    expect(texts).toEqual(['group text', 'text for m1'])
  })

  it('resumes from the persisted cursor — a second run indexes nothing new', async () => {
    store.putSourceMessages([msg('m1'), msg('m2'), msg('m3')])

    const first = await runIndexer({
      store,
      embed: fakeEmbed,
      model_id: 'test-model',
      model_version: 'v1',
    })
    expect(first.indexed).toBe(3)

    const second = await runIndexer({
      store,
      embed: fakeEmbed,
      model_id: 'test-model',
      model_version: 'v1',
    })
    expect(second.indexed).toBe(0)
    expect(store.countSemantic('test-model')).toBe(3)

    // A newly-added message after the cursor IS picked up on a third run.
    store.putSourceMessages([msg('m4')])
    const third = await runIndexer({
      store,
      embed: fakeEmbed,
      model_id: 'test-model',
      model_version: 'v1',
    })
    expect(third.indexed).toBe(1)
    expect(store.countSemantic('test-model')).toBe(4)
  })

  it('paginates across multiple batches', async () => {
    const msgs = Array.from({ length: 5 }, (_, i) => msg(`m${i}`))
    store.putSourceMessages(msgs)

    const result = await runIndexer({
      store,
      embed: fakeEmbed,
      model_id: 'test-model',
      model_version: 'v1',
      batch: 2,
    })

    expect(result.indexed).toBe(5)
    expect(store.countSemantic('test-model')).toBe(5)
  })

  it('keeps separate cursors per model_id', async () => {
    store.putSourceMessages([msg('m1'), msg('m2')])

    await runIndexer({ store, embed: fakeEmbed, model_id: 'model-a', model_version: 'v1' })
    const runB = await runIndexer({ store, embed: fakeEmbed, model_id: 'model-b', model_version: 'v1' })

    expect(runB.indexed).toBe(2)
    expect(store.countSemantic('model-a')).toBe(2)
    expect(store.countSemantic('model-b')).toBe(2)
  })
})
