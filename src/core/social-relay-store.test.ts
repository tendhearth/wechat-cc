import { describe, it, expect } from 'vitest'
import { openDb } from '../lib/db'
import { makeRelayStore } from './social-relay-store'

describe('makeRelayStore', () => {
  it('creates relays, gets by id + by (intent,downstream), records both reveal legs, lists newest-first', () => {
    const db = openDb({ path: ':memory:' })
    const r = makeRelayStore(db)
    r.create({ id: 'i1:tokA', intentId: 'i1', relayToken: 'tokA', upstreamAgentId: 'ccs', downstreamAgentId: 'ccq' })
    r.create({ id: 'i2:tokB', intentId: 'i2', relayToken: 'tokB', upstreamAgentId: 'ccs', downstreamAgentId: 'ccz' })
    expect(r.list().map(x => x.id)).toEqual(['i2:tokB', 'i1:tokA'])   // newest first

    const byId = r.get('i1:tokA')!
    expect(byId.intent_id).toBe('i1')
    expect(byId.upstream_agent_id).toBe('ccs')
    expect(byId.downstream_agent_id).toBe('ccq')
    expect(byId.upstream_revealed_at).toBeNull()
    expect(byId.downstream_revealed_at).toBeNull()

    const byPair = r.getByIntentDownstream('i1', 'ccq')!
    expect(byPair.id).toBe('i1:tokA')
    expect(r.getByIntentDownstream('i1', 'nobody')).toBeNull()

    r.setUpstreamRevealed('i1:tokA', '2026-07-15T00:00:00.000Z')
    r.setDownstreamRevealed('i1:tokA', '2026-07-15T00:01:00.000Z')
    const after = r.get('i1:tokA')!
    expect(after.upstream_revealed_at).toBe('2026-07-15T00:00:00.000Z')
    expect(after.downstream_revealed_at).toBe('2026-07-15T00:01:00.000Z')
    expect(r.get('nope')).toBeNull()
  })
})
