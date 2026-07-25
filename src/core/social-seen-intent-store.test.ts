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

  it('dedup does not depend on the card expires_at: non-expired card dedups (baseline)', () => {
    const db = openDb({ path: ':memory:' })
    const s = makeSeenIntentStore(db)
    s.markSeen({ intentId: 'fresh', expiresAt: '2099-01-01T00:00:00.000Z' })
    expect(s.hasSeen('fresh')).toBe(true)
  })

  it('REGRESSION (DoS-defeat): a peer-supplied expires_at in the PAST does not defeat dedup', () => {
    // A malicious paired peer controls the inbound card's expires_at field.
    // If markSeen inserted the row and then immediately pruned it because the
    // *card's* expires_at was already in the past, hasSeen would read false
    // right after markSeen — letting the peer resubmit the same intent_id and
    // re-trigger a full forward fan-out on every POST. The dedup window must
    // be server-controlled and independent of this attacker-controlled input.
    const db = openDb({ path: ':memory:' })
    const s = makeSeenIntentStore(db)
    s.markSeen({ intentId: 'lying-peer', expiresAt: '2000-01-01T00:00:00.000Z' })
    expect(s.hasSeen('lying-peer')).toBe(true)
  })

  it('markSeen prunes rows past the server retention window, independent of expires_at', () => {
    const db = openDb({ path: ':memory:' })
    const s = makeSeenIntentStore(db)

    // Directly insert a row whose first_seen_at is well older than the server
    // retention window (SEEN_RETENTION_MS = 1h), with a far-future expires_at
    // to prove pruning is driven by first_seen_at, not expires_at.
    const oldFirstSeenAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() // 2h ago
    db.query<unknown, [string, string, string]>(
      `INSERT INTO social_seen_intent(intent_id, first_seen_at, expires_at) VALUES (?, ?, ?)`,
    ).run('stale', oldFirstSeenAt, '2099-01-01T00:00:00.000Z')

    // markSeen for a different, fresh intent should prune the stale row.
    s.markSeen({ intentId: 'new', expiresAt: '2099-01-01T00:00:00.000Z' })

    const rows = db.query<{ intent_id: string }, []>(
      'SELECT intent_id FROM social_seen_intent ORDER BY intent_id',
    ).all()
    expect(rows.map((r) => r.intent_id)).toEqual(['new'])
    expect(s.hasSeen('stale')).toBe(false)
  })

  it('markSeen 记 origin;originOf 取回;无 origin 的行(老数据/缺省)→ null', () => {
    const db = openDb({ path: ':memory:' })
    const s = makeSeenIntentStore(db)
    s.markSeen({ intentId: 'i1', expiresAt: new Date(Date.now() + 60000).toISOString(), originAgentId: 'cc-s' })
    s.markSeen({ intentId: 'i2', expiresAt: new Date(Date.now() + 60000).toISOString() })
    expect(s.originOf('i1')).toBe('cc-s')
    expect(s.originOf('i2')).toBeNull()
    expect(s.originOf('nope')).toBeNull()
    // 幂等重 mark 不覆盖 origin(INSERT OR IGNORE 语义)
    s.markSeen({ intentId: 'i1', expiresAt: new Date().toISOString(), originAgentId: 'other' })
    expect(s.originOf('i1')).toBe('cc-s')
  })
})
