// src/core/knowledge/graph-build.test.ts
//
// Knowledge Graph inproc Task 4 — rebuildGraphFromSource is the glue between
// the already-open KnowledgeStore (source.db) and the pure graph modules
// (buildProfiles/detectOwner/buildMentionEdges, GR T2/T3): read everything
// currently in source, build the graph, write it to graph.db. These tests
// seed a REAL source store (openKnowledge + putSourceMessages/putMentions,
// not fakes) and assert on the REAL graph store's contents afterward —
// end-to-end through the actual store.ts wiring these tests share with
// graph-store.test.ts and store.test.ts.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openKnowledge, type KnowledgeStore, type SourceMsg } from './store'
import { rebuildGraphFromSource } from './graph-build'

function msg(msg_key: string, overrides: Partial<SourceMsg> = {}): SourceMsg {
  return {
    msg_key,
    conversation: 'wxid_alice',
    sender: 'me',
    time: 1000,
    type: 'text',
    text: 'hi',
    server_id: 'srv-1',
    local_type: 1,
    is_group: false,
    kind: 'text',
    ...overrides,
  }
}

describe('rebuildGraphFromSource', () => {
  let dir: string
  let store: KnowledgeStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kk-graph-build-'))
    store = openKnowledge(dir)
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('builds owner + contacts + a mention edge from seeded 1:1 and group source', () => {
    // 1:1 thread with alice — "me" sends more than it receives, so detectOwner
    // (no override) votes "me" as the owner (sender != conversation side).
    store.putSourceMessages([
      msg('m1', { conversation: 'wxid_alice', sender: 'me', time: 100 }),
      msg('m2', { conversation: 'wxid_alice', sender: 'wxid_alice', time: 200 }),
      msg('m3', { conversation: 'wxid_alice', sender: 'me', time: 300 }),
      // A group message from alice that @-mentions bob.
      msg('g1', {
        conversation: 'g1@chatroom',
        sender: 'wxid_alice',
        time: 400,
        is_group: true,
        kind: 'text',
        text: '@bob hi',
      }),
    ])
    store.putMentions([{ msg_key: 'g1', target_un: 'wxid_bob' }])

    const result = rebuildGraphFromSource({ store, now: 100000 })

    expect(result.skipped).toBe(false)
    expect(result.owner).toBe('me')
    expect(result.contacts).toBe(1) // only wxid_alice — group messages don't create 1:1 contacts
    expect(result.builtAt).toBe(100000)

    expect(store.getGraphMeta('owner')).toBe('me')
    expect(store.getGraphMeta('built_at')).toBe('100000')
    expect(store.countContacts()).toBe(1)

    const alice = store.getContact('wxid_alice')
    expect(alice).toBeTruthy()
    expect(alice?.total).toBe(3)
    expect(alice?.sent).toBe(2) // "me" sent m1, m3
    expect(alice?.recv).toBe(1) // alice sent m2

    const mentionEdge = store.edgesFor('wxid_alice', 'mention')
    expect(mentionEdge).toEqual([{ a: 'wxid_alice', b: 'wxid_bob', kind: 'mention', weight: 1 }])
  })

  it('honors ownerOverride even when vote-detection would pick someone else', () => {
    store.putSourceMessages([
      msg('m1', { conversation: 'wxid_alice', sender: 'wxid_alice', time: 100 }),
      msg('m2', { conversation: 'wxid_alice', sender: 'wxid_alice', time: 200 }),
    ])
    const result = rebuildGraphFromSource({ store, now: 1, ownerOverride: 'forced_owner' })
    expect(result.owner).toBe('forced_owner')
    expect(store.getGraphMeta('owner')).toBe('forced_owner')
  })

  it('the very first call runs even against an empty source (produces an empty but present graph)', () => {
    const result = rebuildGraphFromSource({ store, now: 5 })
    expect(result.skipped).toBe(false)
    expect(result.contacts).toBe(0)
    expect(result.owner).toBeNull()
    expect(store.getGraphMeta('source_watermark')).toBe('0')
  })

  it('incremental: a second call with no new source since the last build is a no-op (watermark gate)', () => {
    store.putSourceMessages([msg('m1', { conversation: 'wxid_alice', sender: 'me' })])
    const first = rebuildGraphFromSource({ store, now: 1000 })
    expect(first.skipped).toBe(false)
    expect(store.countContacts()).toBe(1)

    // No new putSourceMessages call in between — source watermark unchanged.
    const second = rebuildGraphFromSource({ store, now: 2000 })
    expect(second.skipped).toBe(true)
    expect(second.contacts).toBe(0)
    expect(second.edges).toBe(0)
    // builtAt reflects the PREVIOUS real build (1000), not this call's `now`.
    expect(second.builtAt).toBe(1000)
    expect(second.owner).toBe(store.getGraphMeta('owner'))

    // The store itself is untouched — still the first build's snapshot.
    expect(store.getGraphMeta('built_at')).toBe('1000')
    expect(store.countContacts()).toBe(1)
  })

  it('new source after a build un-gates the next call', () => {
    store.putSourceMessages([msg('m1', { conversation: 'wxid_alice', sender: 'me' })])
    rebuildGraphFromSource({ store, now: 1000 })
    expect(store.countContacts()).toBe(1)

    store.putSourceMessages([msg('m2', { conversation: 'wxid_carol', sender: 'me' })])
    const second = rebuildGraphFromSource({ store, now: 2000 })
    expect(second.skipped).toBe(false)
    expect(store.countContacts()).toBe(2)
    expect(store.getGraphMeta('built_at')).toBe('2000')
  })
})
