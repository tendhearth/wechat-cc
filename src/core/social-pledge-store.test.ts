import { describe, it, expect } from 'vitest'
import { openDb } from '../lib/db'
import { makePledgeStore } from './social-pledge-store'

describe('makePledgeStore', () => {
  it('creates pledges, lists newest-first, gets by id, and records reveal timestamps', () => {
    const db = openDb({ path: ':memory:' })
    const p = makePledgeStore(db)
    p.create({ id: 'i1:cca', intentId: 'i1', seekerAgentId: 'cca', topic: '找摄影搭子' })
    p.create({ id: 'i2:ccd', intentId: 'i2', seekerAgentId: 'ccd', topic: '找球友' })
    expect(p.list().map(r => r.id)).toEqual(['i2:ccd', 'i1:cca'])   // newest first
    const row = p.get('i1:cca')!
    expect(row.intent_id).toBe('i1')
    expect(row.seeker_agent_id).toBe('cca')
    expect(row.self_revealed_at).toBeNull()
    expect(row.peer_revealed_at).toBeNull()
    p.setSelfRevealed('i1:cca', '2026-07-15T00:00:00.000Z')
    p.setPeerRevealed('i1:cca', '2026-07-15T00:01:00.000Z')
    const after = p.get('i1:cca')!
    expect(after.self_revealed_at).toBe('2026-07-15T00:00:00.000Z')
    expect(after.peer_revealed_at).toBe('2026-07-15T00:01:00.000Z')
    expect(p.get('nope')).toBeNull()
  })
})
