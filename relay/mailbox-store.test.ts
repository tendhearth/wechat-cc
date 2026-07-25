import { describe, it, expect } from 'vitest'
import { Database } from 'bun:sqlite'
import { makeMailboxStore } from './mailbox-store'

const T0 = 1_000_000
function freshStore(opts?: { ttlMs?: number; depthCap?: number }) {
  return makeMailboxStore(new Database(':memory:'), opts)
}

describe('mailbox-store', () => {
  it('drop → fetchSince returns items in cursor order with next_cursor', () => {
    const s = freshStore()
    s.drop('boxA', 'env1', T0); s.drop('boxA', 'env2', T0); s.drop('boxB', 'other', T0)
    const page = s.fetchSince('boxA', 0, T0 + 1, 10)
    expect(page.items.map(i => i.envelope)).toEqual(['env1', 'env2'])
    expect(page.next_cursor).toBe(page.items[1]!.cursor)
    // content-blind: boxB's item is not visible to boxA
    expect(s.fetchSince('boxB', 0, T0 + 1, 10).items.map(i => i.envelope)).toEqual(['other'])
  })

  it('fetchSince(since) is exclusive; a page is capped at limit', () => {
    const s = freshStore()
    for (let i = 0; i < 5; i++) s.drop('boxA', `e${i}`, T0)
    const first = s.fetchSince('boxA', 0, T0 + 1, 2)
    expect(first.items.map(i => i.envelope)).toEqual(['e0', 'e1'])
    const next = s.fetchSince('boxA', first.next_cursor, T0 + 1, 2)
    expect(next.items.map(i => i.envelope)).toEqual(['e2', 'e3'])
  })

  it('ackUpTo deletes items at/below the cursor; leaves the rest', () => {
    const s = freshStore()
    s.drop('boxA', 'e0', T0); s.drop('boxA', 'e1', T0); s.drop('boxA', 'e2', T0)
    const page = s.fetchSince('boxA', 0, T0 + 1, 10)
    s.ackUpTo('boxA', page.items[1]!.cursor)
    expect(s.fetchSince('boxA', 0, T0 + 1, 10).items.map(i => i.envelope)).toEqual(['e2'])
  })

  it('sweep deletes expired items; TTL hides them from fetch even before sweep', () => {
    const s = freshStore({ ttlMs: 100 })
    s.drop('boxA', 'old', T0)
    expect(s.fetchSince('boxA', 0, T0 + 200, 10).items).toEqual([])   // expired → hidden
    expect(s.sweep(T0 + 200)).toBe(1)
    expect(s.sweep(T0 + 200)).toBe(0)
  })

  it('depth cap drops the oldest over N per recipient', () => {
    const s = freshStore({ depthCap: 3 })
    for (let i = 0; i < 5; i++) s.drop('boxA', `e${i}`, T0)
    expect(s.fetchSince('boxA', 0, T0 + 1, 10).items.map(i => i.envelope)).toEqual(['e2', 'e3', 'e4'])
  })
})
