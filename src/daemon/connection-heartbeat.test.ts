import { describe, expect, it } from 'vitest'
import { openTestDb } from '../lib/db'
import { makeHeartbeatStore } from './connection-heartbeat'

describe('heartbeat store', () => {
  it('records and reads back the last ok timestamp; null when unknown', () => {
    const db = openTestDb()
    const s = makeHeartbeatStore(db)
    expect(s.lastOk('b-im-bot')).toBeNull()
    s.recordOk('b-im-bot', '2026-06-07T01:00:00.000Z')
    expect(s.lastOk('b-im-bot')).toBe('2026-06-07T01:00:00.000Z')
    db.close()
  })

  it('upserts — a second recordOk overwrites the first', () => {
    const db = openTestDb()
    const s = makeHeartbeatStore(db)
    s.recordOk('acct1', '2026-06-07T01:00:00.000Z')
    s.recordOk('acct1', '2026-06-07T02:00:00.000Z')
    expect(s.lastOk('acct1')).toBe('2026-06-07T02:00:00.000Z')
    db.close()
  })

  it('tracks multiple accounts independently', () => {
    const db = openTestDb()
    const s = makeHeartbeatStore(db)
    s.recordOk('acct-a', '2026-06-07T01:00:00.000Z')
    s.recordOk('acct-b', '2026-06-07T02:00:00.000Z')
    expect(s.lastOk('acct-a')).toBe('2026-06-07T01:00:00.000Z')
    expect(s.lastOk('acct-b')).toBe('2026-06-07T02:00:00.000Z')
    expect(s.lastOk('acct-c')).toBeNull()
    db.close()
  })
})
