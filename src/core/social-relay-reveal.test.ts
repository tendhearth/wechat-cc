import { describe, it, expect, vi } from 'vitest'
import { openDb } from '../lib/db'
import { makeRelayStore } from './social-relay-store'
import { makeRelayReconciler } from './social-relay-reveal'
import type { PeerIdentity } from './social-reveal'

const S: PeerIdentity = { name: '小S', url: 'http://s/a2a' }
const Q: PeerIdentity = { name: '小Q', url: 'http://q/a2a' }
const ids: Record<string, PeerIdentity> = { ccs: S, ccq: Q }

function fixture() {
  const db = openDb({ path: ':memory:' })
  const relayStore = makeRelayStore(db)
  relayStore.create({ id: 'i1:T', intentId: 'i1', relayToken: 'T', upstreamAgentId: 'ccs', downstreamAgentId: 'ccq' })
  const completeUpstream = vi.fn()
  const completeDownstream = vi.fn()
  const nudge = vi.fn()
  const notify3way = vi.fn()
  const rec = makeRelayReconciler({
    relayStore,
    identityOf: (id) => ids[id] ?? null,
    completeUpstream, completeDownstream, nudge, notify3way,
  })
  return { relayStore, rec, completeUpstream, completeDownstream, nudge, notify3way }
}

describe('makeRelayReconciler', () => {
  it('no relay row → null (caller falls through to its own echo/pledge revealer)', () => {
    const { rec } = fixture()
    expect(rec.onRelayReveal({ callerAgentId: 'ccx', intentId: 'nope' })).toBeNull()
  })

  it('S reveals first (carries token) → mark upstream, nudge Q with NO token, mutual:false', () => {
    const { rec, relayStore, nudge, completeUpstream, completeDownstream } = fixture()
    const out = rec.onRelayReveal({ callerAgentId: 'ccs', intentId: 'i1', relayToken: 'T' })
    expect(out).toEqual({ mutual: false })
    expect(relayStore.get('i1:T')!.upstream_revealed_at).not.toBeNull()
    expect(nudge).toHaveBeenCalledWith('ccq', 'i1')            // Q's pledge is keyed intent:W → no token
    expect(completeUpstream).not.toHaveBeenCalled()
    expect(completeDownstream).not.toHaveBeenCalled()
  })

  it('Q reveals first (no token) → mark downstream, nudge S WITH token, mutual:false', () => {
    const { rec, relayStore, nudge } = fixture()
    const out = rec.onRelayReveal({ callerAgentId: 'ccq', intentId: 'i1' })
    expect(out).toEqual({ mutual: false })
    expect(relayStore.get('i1:T')!.downstream_revealed_at).not.toBeNull()
    expect(nudge).toHaveBeenCalledWith('ccs', 'i1', 'T')       // S needs the token
  })

  it('S-first then Q → mutual; Q learns S synchronously, S completed via post-back, 3-way fires', () => {
    const { rec, completeUpstream, completeDownstream, notify3way } = fixture()
    rec.onRelayReveal({ callerAgentId: 'ccs', intentId: 'i1', relayToken: 'T' })   // S first
    const out = rec.onRelayReveal({ callerAgentId: 'ccq', intentId: 'i1' })        // Q second
    expect(out).toEqual({ mutual: true, identity: S })          // Q (caller) gets the OTHER party = S
    expect(completeUpstream).toHaveBeenCalledWith('ccs', 'i1', 'T', Q)             // post back to S with Q's identity
    expect(completeDownstream).not.toHaveBeenCalled()
    expect(notify3way).toHaveBeenCalledWith('i1', S, Q)
  })

  it('Q-first then S → mutual; S learns Q synchronously, Q completed via post-back', () => {
    const { rec, completeUpstream, completeDownstream, notify3way } = fixture()
    rec.onRelayReveal({ callerAgentId: 'ccq', intentId: 'i1' })                    // Q first
    const out = rec.onRelayReveal({ callerAgentId: 'ccs', intentId: 'i1', relayToken: 'T' })  // S second
    expect(out).toEqual({ mutual: true, identity: Q })          // S (caller) gets the OTHER party = Q
    expect(completeDownstream).toHaveBeenCalledWith('ccq', 'i1', S)                // post back to Q with S's identity
    expect(completeUpstream).not.toHaveBeenCalled()
    expect(notify3way).toHaveBeenCalledWith('i1', S, Q)
  })

  it('restart survivability: the relay row is durable, reconciliation is process-independent', () => {
    const { rec, relayStore } = fixture()
    rec.onRelayReveal({ callerAgentId: 'ccs', intentId: 'i1', relayToken: 'T' })
    // Simulate a W restart: a fresh reconciler over the SAME store still crosses.
    const rec2 = makeRelayReconciler({
      relayStore,
      identityOf: (id) => ids[id] ?? null,
      completeUpstream: vi.fn(), completeDownstream: vi.fn(), nudge: vi.fn(),
      notify3way: vi.fn(),
    })
    const out = rec2.onRelayReveal({ callerAgentId: 'ccq', intentId: 'i1' })
    expect(out).toEqual({ mutual: true, identity: S })
  })

  it('retried reveal after mutual is idempotent (no duplicate cross/notify)', () => {
    const { rec, completeDownstream, notify3way } = fixture()
    rec.onRelayReveal({ callerAgentId: 'ccq', intentId: 'i1' })
    rec.onRelayReveal({ callerAgentId: 'ccs', intentId: 'i1', relayToken: 'T' })   // reaches mutual
    completeDownstream.mockClear(); notify3way.mockClear()
    const again = rec.onRelayReveal({ callerAgentId: 'ccs', intentId: 'i1', relayToken: 'T' })   // retry
    expect(again).toEqual({ mutual: true, identity: Q })        // consistent answer
    expect(completeDownstream).not.toHaveBeenCalled()           // no duplicate post-back
    expect(notify3way).not.toHaveBeenCalled()                   // no duplicate warmth
  })

  it('crossing reveal with a transient identity-null does NOT strand the leg; heals on retry (review fix)', () => {
    const db = openDb({ path: ':memory:' })
    const relayStore = makeRelayStore(db)
    relayStore.create({ id: 'i1:T', intentId: 'i1', relayToken: 'T', upstreamAgentId: 'ccs', downstreamAgentId: 'ccq' })
    const completeUpstream = vi.fn()
    const completeDownstream = vi.fn()
    const nudge = vi.fn()
    const notify3way = vi.fn()
    let sResolvable = false
    const identityOf = vi.fn((id: string) => (id === 'ccs' ? (sResolvable ? S : null) : (ids[id] ?? null)))
    const rec = makeRelayReconciler({ relayStore, identityOf, completeUpstream, completeDownstream, nudge, notify3way })

    rec.onRelayReveal({ callerAgentId: 'ccq', intentId: 'i1' })   // Q reveals first → marks downstream

    // S reveals second (crossing path) while S's OWN identity is transiently
    // unresolvable in W's registry.
    const first = rec.onRelayReveal({ callerAgentId: 'ccs', intentId: 'i1', relayToken: 'T' })
    expect(first).toEqual({ mutual: false })
    expect(relayStore.get('i1:T')!.upstream_revealed_at).toBeNull()   // NOT marked — must stay retryable
    expect(completeUpstream).not.toHaveBeenCalled()
    expect(completeDownstream).not.toHaveBeenCalled()
    expect(notify3way).not.toHaveBeenCalled()

    // Registry heals; a retry of the SAME reveal now crosses.
    sResolvable = true
    const retried = rec.onRelayReveal({ callerAgentId: 'ccs', intentId: 'i1', relayToken: 'T' })
    expect(retried).toEqual({ mutual: true, identity: Q })
    expect(relayStore.get('i1:T')!.upstream_revealed_at).not.toBeNull()
    expect(completeDownstream).toHaveBeenCalledWith('ccq', 'i1', S)
    expect(completeUpstream).not.toHaveBeenCalled()
    expect(notify3way).toHaveBeenCalledTimes(1)
    expect(notify3way).toHaveBeenCalledWith('i1', S, Q)
  })
})
