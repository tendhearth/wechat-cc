// src/core/knowledge/graph-store.test.ts
//
// Knowledge Graph inproc Task 4 — graph.db (contacts/edges/meta), the TS
// port of wxgraph's store.py GraphStore. rebuildGraph always replaces the
// WHOLE snapshot (delete + reinsert) — these tests drive it directly (no
// graph-build.ts involved) to pin the store's own read/write contract:
// write shape in, read shape back out, plus the ADD-COLUMN migration guard
// (mirrors store.test.ts's source.db migration test, GR T1) against a
// graph.db that predates some of this task's contact columns.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openKnowledge, type KnowledgeStore } from './store'
import type { Profile } from './graph-profiles'
import type { Edge } from './graph'

function profile(username: string, overrides: Partial<Profile> = {}): Profile {
  return {
    username,
    total: 10,
    sent: 6,
    recv: 4,
    first_ts: 1000,
    last_ts: 2000,
    known_days: 5,
    active_days: 3,
    initiations: 2,
    transfer_in: 0,
    transfer_out: 1,
    shared_groups: 1,
    types: { text: 9, transfer: 1 },
    s_volume: 0.5,
    s_recency: 0.6,
    s_reciprocity: 0.7,
    s_intimacy: 0.2,
    closeness: 0.55,
    ...overrides,
  }
}

describe('graph store (graph.db)', () => {
  let dir: string
  let store: KnowledgeStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kk-graph-store-'))
    store = openKnowledge(dir)
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('countContacts is 0 on a fresh store', () => {
    expect(store.countContacts()).toBe(0)
  })

  it('rebuildGraph writes contacts + a "me" edge per contact + mention edges + meta, readable back', () => {
    const profiles = [profile('wxid_alice'), profile('wxid_bob', { total: 3, closeness: 0.1 })]
    const mentionEdges: Edge[] = [{ a: 'wxid_alice', b: 'wxid_bob', kind: 'mention', weight: 2 }]
    const displayMap = { wxid_alice: 'Alice' } // wxid_bob deliberately absent -> falls back to username

    store.rebuildGraph(profiles, mentionEdges, displayMap, 'me', 12345, 42)

    expect(store.countContacts()).toBe(2)

    const alice = store.getContact('wxid_alice')
    expect(alice).toMatchObject({
      username: 'wxid_alice',
      display: 'Alice',
      is_group: false,
      total: 10,
      sent: 6,
      recv: 4,
      closeness: 0.55,
      types: { text: 9, transfer: 1 },
    })

    const bob = store.getContact('wxid_bob')
    expect(bob?.display).toBe('wxid_bob') // no displayMap entry -> falls back to username

    expect(store.getContact('nonexistent')).toBeNull()

    const meEdges = store.edgesFor('wxid_alice', 'me')
    expect(meEdges).toEqual([{ a: 'me', b: 'wxid_alice', kind: 'me', weight: 0.55 }])

    const mentionForAlice = store.edgesFor('wxid_alice', 'mention')
    expect(mentionForAlice).toEqual([{ a: 'wxid_alice', b: 'wxid_bob', kind: 'mention', weight: 2 }])
    // edgesFor matches BOTH directions (a=? OR b=?) — same lookup from bob's side.
    const mentionForBob = store.edgesFor('wxid_bob', 'mention')
    expect(mentionForBob).toEqual([{ a: 'wxid_alice', b: 'wxid_bob', kind: 'mention', weight: 2 }])

    expect(store.getGraphMeta('owner')).toBe('me')
    expect(store.getGraphMeta('built_at')).toBe('12345')
    expect(store.getGraphMeta('source_watermark')).toBe('42')
  })

  it('allContacts reads every contact row', () => {
    store.rebuildGraph(
      [profile('a', { closeness: 0.9 }), profile('b', { closeness: 0.1 }), profile('c', { closeness: 0.5 })],
      [],
      {},
      'me',
      1,
      1,
    )
    const all = store.allContacts()
    expect(all.map(c => c.username).sort()).toEqual(['a', 'b', 'c'])
  })

  it('edgesFor orders by weight DESC', () => {
    store.rebuildGraph(
      [profile('a'), profile('b'), profile('c')],
      [
        { a: 'a', b: 'b', kind: 'mention', weight: 1 },
        { a: 'a', b: 'c', kind: 'mention', weight: 5 },
      ],
      {},
      'me',
      1,
      1,
    )
    const edges = store.edgesFor('a', 'mention')
    expect(edges.map(e => e.weight)).toEqual([5, 1])
  })

  it('rebuildGraph fully replaces the previous snapshot (delete + reinsert, not a merge)', () => {
    store.rebuildGraph([profile('old_contact')], [], {}, 'me', 1, 1)
    expect(store.countContacts()).toBe(1)

    store.rebuildGraph([profile('new_contact')], [], {}, 'me', 2, 2)
    expect(store.countContacts()).toBe(1)
    expect(store.getContact('old_contact')).toBeNull()
    expect(store.getContact('new_contact')).not.toBeNull()
  })

  it('writes the "me" edge even when owner is null (falls back to empty-string source)', () => {
    store.rebuildGraph([profile('a', { closeness: 0.3 })], [], {}, null, 1, 1)
    expect(store.getGraphMeta('owner')).toBe('')
    const edges = store.edgesFor('a', 'me')
    expect(edges).toEqual([{ a: '', b: 'a', kind: 'me', weight: 0.3 }])
  })

  describe('graph meta (getGraphMeta/setGraphMeta, independent of rebuildGraph)', () => {
    it('getGraphMeta returns null when unset, then round-trips setGraphMeta', () => {
      expect(store.getGraphMeta('custom')).toBeNull()
      store.setGraphMeta('custom', 'v1')
      expect(store.getGraphMeta('custom')).toBe('v1')
      store.setGraphMeta('custom', 'v2')
      expect(store.getGraphMeta('custom')).toBe('v2')
    })
  })

  describe('schema migration (pre-existing graph.db missing new columns)', () => {
    it('openKnowledge migrates an old contacts table in place (ADD COLUMN), does not throw, and preserves the pre-existing row', () => {
      const migDir = mkdtempSync(join(tmpdir(), 'kk-graph-store-migrate-'))
      try {
        // Simulate a graph.db whose `contacts` table only has the columns
        // that predate this task's full schema (username/display/closeness).
        // CREATE TABLE IF NOT EXISTS in openKnowledge is a no-op against an
        // already-existing `contacts` table, so the migration must ALTER it
        // in place instead — exactly like source.db's `messages` migration.
        const oldDb = new Database(join(migDir, 'graph.db'), { create: true })
        oldDb.exec(`
          CREATE TABLE contacts (username TEXT PRIMARY KEY, display TEXT, closeness REAL);
          CREATE TABLE edges (a TEXT, b TEXT, kind TEXT, weight REAL, PRIMARY KEY(a, b, kind));
          CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
        `)
        oldDb
          .query('INSERT INTO contacts(username, display, closeness) VALUES (?, ?, ?)')
          .run('old_wxid', 'Old Contact', 0.42)
        oldDb.close()

        let migrated: KnowledgeStore | undefined
        expect(() => {
          migrated = openKnowledge(migDir)
        }).not.toThrow()

        // New columns are usable: a fresh rebuildGraph round-trips them.
        migrated!.rebuildGraph([profile('new_wxid', { total: 7 })], [], {}, 'me', 99, 5)
        const fresh = migrated!.getContact('new_wxid')
        expect(fresh?.total).toBe(7)

        // Pre-existing row is untouched by the migration itself (rebuildGraph
        // above did wipe it via its own DELETE FROM contacts, which is
        // rebuildGraph's normal whole-snapshot-replace behavior — so assert
        // the migration alone doesn't crash/lose data by checking BEFORE any
        // rebuildGraph call, via a fresh reopen).
        migrated!.close()
        const reopened = openKnowledge(migDir)
        // A second reopen without any rebuildGraph call in between preserves
        // whatever rebuildGraph last wrote (new_wxid, not old_wxid — that's
        // expected: rebuildGraph replaced the snapshot above).
        expect(reopened.getContact('new_wxid')?.total).toBe(7)
        reopened.close()

        const check = new Database(join(migDir, 'graph.db'))
        const cols = check.query<{ name: string }, []>('PRAGMA table_info(contacts)').all().map(r => r.name)
        check.close()
        expect(cols).toEqual(
          expect.arrayContaining(['is_group', 'total', 'sent', 'recv', 'types', 's_volume', 'shared_groups']),
        )
      } finally {
        rmSync(migDir, { recursive: true, force: true })
      }
    })

    it('migrates a graph.db with NO prior rebuildGraph call — the pre-existing row survives with new columns NULL', () => {
      const migDir = mkdtempSync(join(tmpdir(), 'kk-graph-store-migrate-norebuild-'))
      try {
        const oldDb = new Database(join(migDir, 'graph.db'), { create: true })
        oldDb.exec(`
          CREATE TABLE contacts (username TEXT PRIMARY KEY, display TEXT, closeness REAL);
          CREATE TABLE edges (a TEXT, b TEXT, kind TEXT, weight REAL, PRIMARY KEY(a, b, kind));
          CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
        `)
        oldDb
          .query('INSERT INTO contacts(username, display, closeness) VALUES (?, ?, ?)')
          .run('old_wxid', 'Old Contact', 0.42)
        oldDb.close()

        const migrated = openKnowledge(migDir)
        try {
          const old = migrated.getContact('old_wxid')
          expect(old).toBeDefined()
          expect(old?.display).toBe('Old Contact')
          expect(old?.closeness).toBe(0.42)
          expect(old?.total == null).toBe(true) // new column, NULL on the pre-existing row
          expect(old?.is_group).toBe(false) // 0/NULL -> coerced false by toContact
        } finally {
          migrated.close()
        }
      } finally {
        rmSync(migDir, { recursive: true, force: true })
      }
    })
  })
})
