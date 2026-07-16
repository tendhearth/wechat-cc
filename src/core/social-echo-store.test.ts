import { describe, it, expect } from 'vitest'
import { openDb } from '../lib/db'
import { makeEchoStore } from './social-echo-store'

describe('makeEchoStore', () => {
  it('creates pending echoes, lists by seek + all, and updates status', () => {
    const db = openDb({ path: ':memory:' })
    const e = makeEchoStore(db)
    e.create({ id: 'e1', seekId: 'k1', peerMasked: '第 1 度的某人', degree: 1, content: '我认识个老师傅', peerAgentId: 'ccb' })
    e.create({ id: 'e2', seekId: 'k1', peerMasked: '第 1 度的某人', degree: 1, content: '我家布偶生了一窝', peerAgentId: 'ccc' })
    expect(e.get('e1')!.status).toBe('pending')
    expect(e.get('e1')!.peer_agent_id).toBe('ccb')
    expect(e.get('e1')!.self_revealed_at).toBeNull()
    expect(e.get('e1')!.peer_revealed_at).toBeNull()
    expect(e.listForSeek('k1').map(r => r.id).sort()).toEqual(['e1', 'e2'])
    e.setStatus('e1', 'revealed')
    expect(e.get('e1')!.status).toBe('revealed')
    expect(e.listAll().length).toBe(2)
  })

  it('records the two reveal timestamps + swaps the masked name for the real identity', () => {
    const db = openDb({ path: ':memory:' })
    const e = makeEchoStore(db)
    e.create({ id: 'e1', seekId: 'k1', peerMasked: '第 1 度的某人', degree: 1, content: 'x', peerAgentId: 'ccb' })
    e.setSelfRevealed('e1', '2026-07-15T00:00:00.000Z')
    e.setPeerRevealed('e1', '2026-07-15T00:01:00.000Z')
    e.setRevealedIdentity('e1', '小B')
    const r = e.get('e1')!
    expect(r.self_revealed_at).toBe('2026-07-15T00:00:00.000Z')
    expect(r.peer_revealed_at).toBe('2026-07-15T00:01:00.000Z')
    expect(r.peer_masked).toBe('小B')
  })
})
