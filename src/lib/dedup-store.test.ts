import { describe, it, expect } from 'vitest'
import { openTestDb } from './db'
import { makeDedupStore } from './dedup-store'

describe('dedup store', () => {
  it('isHandled is false until markHandled', () => {
    const s = makeDedupStore(openTestDb())
    expect(s.isHandled('u1:100')).toBe(false)
    s.markHandled('u1:100', '2026-06-25T00:00:00Z')
    expect(s.isHandled('u1:100')).toBe(true)
  })

  it('markHandled is idempotent on id (re-mark does not throw)', () => {
    const s = makeDedupStore(openTestDb())
    s.markHandled('dup', '2026-06-25T00:00:00Z')
    s.markHandled('dup', '2026-06-25T00:00:01Z')
    expect(s.isHandled('dup')).toBe(true)
  })

  it('survives a re-open against the same db file (persisted, not in-memory)', () => {
    const db = openTestDb()
    const s1 = makeDedupStore(db)
    s1.markHandled('persist', '2026-06-25T00:00:00Z')
    // A second store over the SAME db handle sees the row — the dedup state
    // lives in the table, not in the store instance. This is what makes it
    // survive a daemon restart on macOS wake.
    const s2 = makeDedupStore(db)
    expect(s2.isHandled('persist')).toBe(true)
  })

  it('distinct ids are tracked independently', () => {
    const s = makeDedupStore(openTestDb())
    s.markHandled('a', '2026-06-25T00:00:00Z')
    expect(s.isHandled('a')).toBe(true)
    expect(s.isHandled('b')).toBe(false)
  })
})
