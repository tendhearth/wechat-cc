import { describe, it, expect } from 'vitest'
import { openDb } from '../lib/db'
import { makeSeenIntentStore } from './social-seen-intent-store'

describe('makeSeenIntentStore', () => {
  it('marks an intent seen once (idempotent) and answers hasSeen', () => {
    const db = openDb({ path: ':memory:' })
    const s = makeSeenIntentStore(db)
    expect(s.hasSeen('i1')).toBe(false)
    s.markSeen({ intentId: 'i1', expiresAt: '2026-07-15T01:00:00.000Z' })
    expect(s.hasSeen('i1')).toBe(true)
    // Idempotent: a second markSeen (diamond path / cycle) does not throw on the PK.
    s.markSeen({ intentId: 'i1', expiresAt: '2026-07-15T02:00:00.000Z' })
    expect(s.hasSeen('i1')).toBe(true)
    expect(s.hasSeen('other')).toBe(false)
  })
})
