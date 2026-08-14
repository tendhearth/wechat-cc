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

  it('persists each leg\'s presented pubkey handle (content-blind crossing material)', () => {
    const db = openDb({ path: ':memory:' })
    const r = makeRelayStore(db)
    r.create({ id: 'i1:tokA', intentId: 'i1', relayToken: 'tokA', upstreamAgentId: 'ccs', downstreamAgentId: 'ccq' })
    expect(r.get('i1:tokA')!.upstream_handle).toBeNull()
    expect(r.get('i1:tokA')!.downstream_handle).toBeNull()

    r.setUpstreamHandle('i1:tokA', { pubkey: 'P', channel_id: 'C' })
    expect(r.get('i1:tokA')!.upstream_handle).toBe(JSON.stringify({ pubkey: 'P', channel_id: 'C' }))

    r.setDownstreamHandle('i1:tokA', { pubkey: 'Q', channel_id: 'D' })
    expect(r.get('i1:tokA')!.downstream_handle).toBe(JSON.stringify({ pubkey: 'Q', channel_id: 'D' }))
  })

  it('getByEndpointChannelId scans both stored handles to find the leg a channel_id belongs to', () => {
    const db = openDb({ path: ':memory:' })
    const r = makeRelayStore(db)
    r.create({ id: 'i1:tokA', intentId: 'i1', relayToken: 'tokA', upstreamAgentId: 'ccs', downstreamAgentId: 'ccq' })
    r.setUpstreamHandle('i1:tokA', { pubkey: 'Spub', channel_id: 'chan-s' })
    r.setDownstreamHandle('i1:tokA', { pubkey: 'Qpub', channel_id: 'chan-q' })

    expect(r.getByEndpointChannelId('chan-s')?.id).toBe('i1:tokA')
    expect(r.getByEndpointChannelId('chan-q')?.id).toBe('i1:tokA')
    expect(r.getByEndpointChannelId('unknown-channel')).toBeNull()
  })
})
