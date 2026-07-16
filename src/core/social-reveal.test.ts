import { describe, it, expect, vi } from 'vitest'
import { openDb } from '../lib/db'
import { makeEchoStore } from './social-echo-store'
import { makePledgeStore } from './social-pledge-store'
import { makeSeekStore } from './social-seek-store'
import { makeRevealer, type PeerIdentity } from './social-reveal'

const SELF: PeerIdentity = { name: '我方', url: 'http://self/a2a' }
const PEER: PeerIdentity = { name: '小B', url: 'http://peerb/a2a' }

function fixture(postPeerReveal: any) {
  const db = openDb({ path: ':memory:' })
  const echoStore = makeEchoStore(db)
  const pledgeStore = makePledgeStore(db)
  const seekStore = makeSeekStore(db)
  const notify = vi.fn()
  const revealer = makeRevealer({ echoStore, pledgeStore, seekStore, postPeerReveal, selfIdentity: () => SELF, notify })
  return { db, echoStore, pledgeStore, seekStore, notify, revealer }
}

describe('makeRevealer — echo side (I reveal first)', () => {
  it('I reveal, peer already consented → mutual: echo revealed, seek connected, identity swapped, beat #3', async () => {
    const post = vi.fn(async () => ({ mutual: true, identity: PEER }))
    const { echoStore, seekStore, notify, revealer } = fixture(post)
    seekStore.create({ id: 'i1', kind: 'seek', topic: 't' })
    echoStore.create({ id: 'i1:ccb', seekId: 'i1', peerMasked: '第 1 度的某人', degree: 1, content: 'x', peerAgentId: 'ccb' })

    const out = await revealer.revealEcho('i1:ccb')

    expect(out).toEqual({ state: 'connected' })
    expect(post).toHaveBeenCalledWith('ccb', 'i1')
    const echo = echoStore.get('i1:ccb')!
    expect(echo.status).toBe('revealed')
    expect(echo.self_revealed_at).not.toBeNull()
    expect(echo.peer_revealed_at).not.toBeNull()
    expect(echo.peer_masked).toBe('小B')                    // identity swapped in
    expect(seekStore.get('i1')!.status).toBe('connected')
    expect(notify).toHaveBeenCalledWith('connected', expect.objectContaining({ intentId: 'i1', peerName: '小B' }))
  })

  it('I reveal, peer has NOT → awaiting_peer, my consent persisted, no connected beat', async () => {
    const post = vi.fn(async () => ({ mutual: false }))
    const { echoStore, seekStore, notify, revealer } = fixture(post)
    seekStore.create({ id: 'i1', kind: 'seek', topic: 't' })
    echoStore.create({ id: 'i1:ccb', seekId: 'i1', peerMasked: '第 1 度的某人', degree: 1, content: 'x', peerAgentId: 'ccb' })

    const out = await revealer.revealEcho('i1:ccb')

    expect(out).toEqual({ state: 'awaiting_peer' })
    expect(echoStore.get('i1:ccb')!.self_revealed_at).not.toBeNull()
    expect(echoStore.get('i1:ccb')!.peer_revealed_at).toBeNull()
    expect(seekStore.get('i1')!.status).toBe('foraging')
    expect(notify).not.toHaveBeenCalledWith('connected', expect.anything())
  })

  it('peer unreachable → peer_unreachable, my consent is NOT lost, retryable', async () => {
    const post = vi.fn(async () => null)
    const { echoStore, revealer } = fixture(post)
    echoStore.create({ id: 'i1:ccb', seekId: 'i1', peerMasked: '第 1 度的某人', degree: 1, content: 'x', peerAgentId: 'ccb' })

    const out = await revealer.revealEcho('i1:ccb')

    expect(out).toEqual({ state: 'peer_unreachable' })
    expect(echoStore.get('i1:ccb')!.self_revealed_at).not.toBeNull()
  })

  it('double reveal after connected is a no-op (idempotent)', async () => {
    const post = vi.fn(async () => ({ mutual: true, identity: PEER }))
    const { echoStore, revealer } = fixture(post)
    echoStore.create({ id: 'i1:ccb', seekId: 'i1', peerMasked: '第 1 度的某人', degree: 1, content: 'x', peerAgentId: 'ccb' })
    await revealer.revealEcho('i1:ccb')
    post.mockClear()
    const out = await revealer.revealEcho('i1:ccb')
    expect(out).toEqual({ state: 'connected' })
    expect(post).not.toHaveBeenCalled()                     // already mutual → no second outbound call
  })

  it('returns null when the echo id does not exist', async () => {
    const { revealer } = fixture(vi.fn(async () => null))
    expect(await revealer.revealEcho('nope:ccb')).toBeNull()
  })
})

describe('makeRevealer — inbound (peer reveals first)', () => {
  it('peer reveals before me → mutual:false, beat #2 (await_reveal) fires', () => {
    const { echoStore, notify, revealer } = fixture(vi.fn())
    echoStore.create({ id: 'i1:ccb', seekId: 'i1', peerMasked: '第 1 度的某人', degree: 1, content: 'x', peerAgentId: 'ccb' })

    const resp = revealer.onInboundReveal({ agentId: 'ccb', intentId: 'i1' })

    expect(resp).toEqual({ mutual: false })
    expect(echoStore.get('i1:ccb')!.peer_revealed_at).not.toBeNull()
    expect(notify).toHaveBeenCalledWith('await_reveal', expect.objectContaining({ intentId: 'i1', peerAgentId: 'ccb' }))
  })

  it('second revealer gets mutual synchronously with our identity (I revealed first, peer calls in)', () => {
    const { echoStore, seekStore, notify, revealer } = fixture(vi.fn())
    seekStore.create({ id: 'i1', kind: 'seek', topic: 't' })
    echoStore.create({ id: 'i1:ccb', seekId: 'i1', peerMasked: '第 1 度的某人', degree: 1, content: 'x', peerAgentId: 'ccb' })
    echoStore.setSelfRevealed('i1:ccb', '2026-07-15T00:00:00.000Z')  // I already revealed

    const resp = revealer.onInboundReveal({ agentId: 'ccb', intentId: 'i1' })

    expect(resp).toEqual({ mutual: true, identity: SELF })
    expect(echoStore.get('i1:ccb')!.status).toBe('revealed')
    expect(seekStore.get('i1')!.status).toBe('connected')
    expect(notify).toHaveBeenCalledWith('connected', expect.objectContaining({ intentId: 'i1', peerAgentId: 'ccb' }))
  })

  it('resolves against a pledge when there is no echo (I answered THEIR wish)', () => {
    const { pledgeStore, notify, revealer } = fixture(vi.fn())
    pledgeStore.create({ id: 'i2:cca', intentId: 'i2', seekerAgentId: 'cca', topic: 't' })

    const resp = revealer.onInboundReveal({ agentId: 'cca', intentId: 'i2' })

    expect(resp).toEqual({ mutual: false })
    expect(pledgeStore.get('i2:cca')!.peer_revealed_at).not.toBeNull()
    expect(notify).toHaveBeenCalledWith('await_reveal', expect.objectContaining({ intentId: 'i2', peerAgentId: 'cca' }))
  })

  it('no matching row → mutual:false, no throw', () => {
    const { revealer } = fixture(vi.fn())
    expect(revealer.onInboundReveal({ agentId: 'zzz', intentId: 'nope' })).toEqual({ mutual: false })
  })

  it('duplicate inbound reveal before I reveal → await_reveal notify fires exactly once', () => {
    const { echoStore, notify, revealer } = fixture(vi.fn())
    echoStore.create({ id: 'i1:ccb', seekId: 'i1', peerMasked: '第 1 度的某人', degree: 1, content: 'x', peerAgentId: 'ccb' })

    const first = revealer.onInboundReveal({ agentId: 'ccb', intentId: 'i1' })
    const second = revealer.onInboundReveal({ agentId: 'ccb', intentId: 'i1' })

    expect(first).toEqual({ mutual: false })
    expect(second).toEqual({ mutual: false })
    expect(notify.mock.calls.filter((c) => c[0] === 'await_reveal').length).toBe(1)
  })

  it('duplicate inbound reveal after connected → connected notify fires exactly once, second call still returns mutual', () => {
    const { echoStore, seekStore, notify, revealer } = fixture(vi.fn())
    seekStore.create({ id: 'i1', kind: 'seek', topic: 't' })
    echoStore.create({ id: 'i1:ccb', seekId: 'i1', peerMasked: '第 1 度的某人', degree: 1, content: 'x', peerAgentId: 'ccb' })
    echoStore.setSelfRevealed('i1:ccb', '2026-07-15T00:00:00.000Z')  // I already revealed

    const first = revealer.onInboundReveal({ agentId: 'ccb', intentId: 'i1' })
    const second = revealer.onInboundReveal({ agentId: 'ccb', intentId: 'i1' })

    expect(first).toEqual({ mutual: true, identity: SELF })
    expect(second).toEqual({ mutual: true, identity: SELF })
    expect(notify.mock.calls.filter((c) => c[0] === 'connected').length).toBe(1)
  })
})

describe('makeRevealer — pledge side (I reveal my answer)', () => {
  it('revealPledge mutual → connected beat, timestamps set', async () => {
    const post = vi.fn(async () => ({ mutual: true, identity: PEER }))
    const { pledgeStore, notify, revealer } = fixture(post)
    pledgeStore.create({ id: 'i2:cca', intentId: 'i2', seekerAgentId: 'cca', topic: 't' })

    const out = await revealer.revealPledge('i2:cca')

    expect(out).toEqual({ state: 'connected' })
    expect(post).toHaveBeenCalledWith('cca', 'i2')
    expect(pledgeStore.get('i2:cca')!.self_revealed_at).not.toBeNull()
    expect(pledgeStore.get('i2:cca')!.peer_revealed_at).not.toBeNull()
    expect(notify).toHaveBeenCalledWith('connected', expect.objectContaining({ intentId: 'i2', peerName: '小B' }))
  })

  it('identity never leaks before reveal', () => {
    const { echoStore, revealer } = fixture(vi.fn())
    echoStore.create({ id: 'i1:ccb', seekId: 'i1', peerMasked: '第 1 度的某人', degree: 1, content: 'x', peerAgentId: 'ccb' })
    // Before any reveal, the masked placeholder is intact and no identity is exposed.
    expect(echoStore.get('i1:ccb')!.peer_masked).toBe('第 1 度的某人')
    // An inbound reveal we have NOT matched with our own consent returns no identity.
    expect(revealer.onInboundReveal({ agentId: 'ccb', intentId: 'i1' })).toEqual({ mutual: false })
  })
})

describe('makeRevealer — relay branch (2-hop, spec #2)', () => {
  it('revealEcho on a relay echo posts to relay_via carrying the relay_token', async () => {
    const post = vi.fn(async () => ({ mutual: false }))
    const { echoStore, revealer } = fixture(post)
    // Relay echo: peer_agent_id null, relay_via = W, relay_token = T, id = intent:W:T.
    echoStore.create({ id: 'i1:ccw:T', seekId: 'i1', peerMasked: '第 2 度的某人', degree: 2, content: 'x', peerAgentId: null, relayVia: 'ccw', relayToken: 'T' })
    const out = await revealer.revealEcho('i1:ccw:T')
    expect(out).toEqual({ state: 'awaiting_peer' })
    expect(post).toHaveBeenCalledWith('ccw', 'i1', 'T')   // addressed to W, carries the token
    expect(echoStore.get('i1:ccw:T')!.self_revealed_at).not.toBeNull()
  })

  it('relay revealEcho mutual → connected, identity swapped from the response', async () => {
    const post = vi.fn(async () => ({ mutual: true, identity: PEER }))   // W returns Q's identity
    const { echoStore, seekStore, revealer } = fixture(post)
    seekStore.create({ id: 'i1', kind: 'seek', topic: 't' })
    echoStore.create({ id: 'i1:ccw:T', seekId: 'i1', peerMasked: '第 2 度的某人', degree: 2, content: 'x', peerAgentId: null, relayVia: 'ccw', relayToken: 'T' })
    const out = await revealer.revealEcho('i1:ccw:T')
    expect(out).toEqual({ state: 'connected' })
    expect(echoStore.get('i1:ccw:T')!.peer_masked).toBe('小B')
    expect(seekStore.get('i1')!.status).toBe('connected')
  })

  it('inbound relay reveal (carries relay_token) resolves the relay echo, not the direct key', () => {
    const { echoStore, notify, revealer } = fixture(vi.fn())
    echoStore.create({ id: 'i1:ccw:T', seekId: 'i1', peerMasked: '第 2 度的某人', degree: 2, content: 'x', peerAgentId: null, relayVia: 'ccw', relayToken: 'T' })
    const resp = revealer.onInboundReveal({ agentId: 'ccw', intentId: 'i1', relayToken: 'T' })
    expect(resp).toEqual({ mutual: false })
    expect(echoStore.get('i1:ccw:T')!.peer_revealed_at).not.toBeNull()
    expect(notify).toHaveBeenCalledWith('await_reveal', expect.objectContaining({ intentId: 'i1' }))
  })

  it('inbound relay reveal completing me → mutual, swaps in peerName + notifies with it', () => {
    const { echoStore, seekStore, notify, revealer } = fixture(vi.fn())
    seekStore.create({ id: 'i1', kind: 'seek', topic: 't' })
    echoStore.create({ id: 'i1:ccw:T', seekId: 'i1', peerMasked: '第 2 度的某人', degree: 2, content: 'x', peerAgentId: null, relayVia: 'ccw', relayToken: 'T' })
    echoStore.setSelfRevealed('i1:ccw:T', '2026-07-15T00:00:00.000Z')   // I revealed first
    const resp = revealer.onInboundReveal({ agentId: 'ccw', intentId: 'i1', relayToken: 'T', peerName: '小Q' })
    expect(resp).toEqual({ mutual: true, identity: SELF })
    expect(echoStore.get('i1:ccw:T')!.peer_masked).toBe('小Q')          // W handed me Q's name
    expect(seekStore.get('i1')!.status).toBe('connected')
    expect(notify).toHaveBeenCalledWith('connected', expect.objectContaining({ intentId: 'i1', peerName: '小Q' }))
  })

  it('retried relay inbound after mutual is idempotent (no duplicate connected beat)', () => {
    const { echoStore, seekStore, notify, revealer } = fixture(vi.fn())
    seekStore.create({ id: 'i1', kind: 'seek', topic: 't' })
    echoStore.create({ id: 'i1:ccw:T', seekId: 'i1', peerMasked: '第 2 度的某人', degree: 2, content: 'x', peerAgentId: null, relayVia: 'ccw', relayToken: 'T' })
    echoStore.setSelfRevealed('i1:ccw:T', '2026-07-15T00:00:00.000Z')
    const first = revealer.onInboundReveal({ agentId: 'ccw', intentId: 'i1', relayToken: 'T', peerName: '小Q' })
    const second = revealer.onInboundReveal({ agentId: 'ccw', intentId: 'i1', relayToken: 'T', peerName: '小Q' })
    expect(first).toEqual({ mutual: true, identity: SELF })
    expect(second).toEqual({ mutual: true, identity: SELF })
    expect(notify.mock.calls.filter((c: any[]) => c[0] === 'connected').length).toBe(1)
  })
})
