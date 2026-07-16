import { describe, it, expect } from 'vitest'
import { openDb } from '../lib/db'
import { makeSeenIntentStore } from './social-seen-intent-store'

describe('makeSeenIntentStore', () => {
  it('marks an intent seen once (idempotent) and answers hasSeen', () => {
    const db = openDb({ path: ':memory:' })
    const s = makeSeenIntentStore(db)
    expect(s.hasSeen('i1')).toBe(false)
    s.markSeen({ intentId: 'i1', expiresAt: '2099-07-15T02:00:00.000Z' })
    expect(s.hasSeen('i1')).toBe(true)
    // Idempotent: a second markSeen (diamond path / cycle) does not throw on the PK.
    s.markSeen({ intentId: 'i1', expiresAt: '2099-07-15T03:00:00.000Z' })
    expect(s.hasSeen('i1')).toBe(true)
    expect(s.hasSeen('other')).toBe(false)
  })

  it('hasSeen is expiry-aware: a non-expired row reads true, an expired row reads false', () => {
    const db = openDb({ path: ':memory:' })
    const s = makeSeenIntentStore(db)
    s.markSeen({ intentId: 'fresh', expiresAt: '2099-01-01T00:00:00.000Z' })
    s.markSeen({ intentId: 'stale', expiresAt: '2000-01-01T00:00:00.000Z' })
    expect(s.hasSeen('fresh')).toBe(true)
    expect(s.hasSeen('stale')).toBe(false)
  })

  it('markSeen prunes already-expired rows so the table stays bounded', () => {
    const db = openDb({ path: ':memory:' })
    const s = makeSeenIntentStore(db)
    // Insert a row that is already expired at insert time.
    s.markSeen({ intentId: 'old', expiresAt: '2000-01-01T00:00:00.000Z' })
    const countBefore = db.query<{ n: number }, []>(
      'SELECT COUNT(*) as n FROM social_seen_intent',
    ).get()?.n
    expect(countBefore).toBe(0) // pruned by its own markSeen call — never observably present
    expect(s.hasSeen('old')).toBe(false)

    // A later markSeen for a different (non-expired) intent also prunes any
    // other stale rows left over in the table.
    db.query<unknown, [string, string, string]>(
      `INSERT INTO social_seen_intent(intent_id, first_seen_at, expires_at) VALUES (?, ?, ?)`,
    ).run('leftover', '1999-01-01T00:00:00.000Z', '1999-01-02T00:00:00.000Z')
    s.markSeen({ intentId: 'new', expiresAt: '2099-01-01T00:00:00.000Z' })
    const rows = db.query<{ intent_id: string }, []>(
      'SELECT intent_id FROM social_seen_intent ORDER BY intent_id',
    ).all()
    expect(rows.map((r) => r.intent_id)).toEqual(['new'])
  })
})
