import { describe, it, expect, vi } from 'vitest'
import { makeEnvelopeDispatch } from './mailbox-dispatch'
import type { A2ARegistry } from './a2a-registry'
import type { A2AAgentRecord } from '../lib/agent-config'

const rec = (id: string): A2AAgentRecord => ({ id, name: id, url: 'http://x/a2a', inbound_api_key: 'k', outbound_api_key: 'k', capabilities: [], paused: false, transport: 'push' })
const registry = (verify: (id: string, b: string) => A2AAgentRecord | null): A2ARegistry =>
  ({ verifyBearer: verify, list: () => [], get: () => null, add() {}, remove() {}, setPaused() {}, update: (() => { throw new Error('x') }) as any })
const log = () => {}

describe('makeEnvelopeDispatch', () => {
  it('reveal: verifyBearer(body.agent_id, bearer) then calls onReveal with the verified id', async () => {
    const onReveal = vi.fn(async () => ({ mutual: false }))
    const onLetter = vi.fn(async () => ({ ok: true }))
    const d = makeEnvelopeDispatch({ registry: registry((id, b) => b === 'good' ? rec(id) : null), onReveal, onLetter, log })
    await d.dispatch({ path: '/a2a/reveal', bearer: 'good', body: { agent_id: 'w', intent_id: 'i1', relay_token: 'rt' } })
    expect(onReveal).toHaveBeenCalledWith(expect.objectContaining({ agent_id: 'w', intent_id: 'i1', relay_token: 'rt' }))
  })
  it('reveal with a bad bearer is dropped (onReveal not called)', async () => {
    const onReveal = vi.fn(async () => ({ mutual: false }))
    const d = makeEnvelopeDispatch({ registry: registry(() => null), onReveal, onLetter: async () => ({ ok: true }), log })
    await d.dispatch({ path: '/a2a/reveal', bearer: 'bad', body: { agent_id: 'w', intent_id: 'i1' } })
    expect(onReveal).not.toHaveBeenCalled()
  })
  it('letter: calls onLetter WITHOUT a registry bearer check (channel-key auth)', async () => {
    const onLetter = vi.fn(async () => ({ ok: true }))
    const d = makeEnvelopeDispatch({ registry: registry(() => null), onReveal: async () => ({ mutual: false }), onLetter, log })
    await d.dispatch({ path: '/a2a/letter', bearer: 'ignored', body: { agent_id: 's', channel_id: 'c', nonce: 'n', ct: 'x', tag: 't' } })
    expect(onLetter).toHaveBeenCalledWith(expect.objectContaining({ channel_id: 'c', ct: 'x' }))
  })
  it('reveal: a complete crossed mailbox (addr/enc_pub/relays) on peer_handle is passed through', async () => {
    const onReveal = vi.fn(async () => ({ mutual: false }))
    const d = makeEnvelopeDispatch({ registry: registry(() => rec('w')), onReveal, onLetter: async () => ({ ok: true }), log })
    const mailbox = { addr: 'a', enc_pub: 'e', relays: ['r1'] }
    await d.dispatch({ path: '/a2a/reveal', bearer: 'good', body: { agent_id: 'w', intent_id: 'i1', peer_handle: { pubkey: 'p', channel_id: 'c', mailbox } } })
    expect(onReveal).toHaveBeenCalledWith(expect.objectContaining({ peer_handle: { pubkey: 'p', channel_id: 'c', mailbox } }))
  })
  it('reveal: a PARTIAL crossed mailbox (missing enc_pub) is dropped — not stored on peer_handle', async () => {
    const onReveal = vi.fn(async () => ({ mutual: false }))
    const d = makeEnvelopeDispatch({ registry: registry(() => rec('w')), onReveal, onLetter: async () => ({ ok: true }), log })
    const partialMailbox = { addr: 'a', relays: ['r1'] }   // enc_pub missing
    await d.dispatch({ path: '/a2a/reveal', bearer: 'good', body: { agent_id: 'w', intent_id: 'i1', peer_handle: { pubkey: 'p', channel_id: 'c', mailbox: partialMailbox } } })
    expect(onReveal).toHaveBeenCalledWith(expect.objectContaining({ peer_handle: { pubkey: 'p', channel_id: 'c' } }))
  })
  it('unknown path is a no-op; malformed body never throws', async () => {
    const d = makeEnvelopeDispatch({ registry: registry(() => null), onReveal: async () => ({ mutual: false }), onLetter: async () => ({ ok: true }), log })
    await expect(d.dispatch({ path: '/a2a/intent', bearer: 'b', body: {} })).resolves.toBeUndefined()
    await expect(d.dispatch({ path: '/a2a/letter', bearer: 'b', body: null })).resolves.toBeUndefined()
  })
  it('intent envelope: bearer 验证过 → onIntent({agent, card}); 坏卡 drop', async () => {
    const onIntent = vi.fn(async () => ({ intent_id: 'i1', match: 'yes' as const }))
    const agent = rec('cc-s')
    const d = makeEnvelopeDispatch({
      registry: registry((id, b) => (id === 'cc-s' && b === 'k') ? agent : null),
      onReveal: async () => ({ mutual: false }), onLetter: async () => ({ ok: true }), onIntent, log,
    })
    const card = { intent_id: 'i1', kind: 'seek' as const, topic: '找摄影搭子', expires_at: new Date(Date.now() + 60000).toISOString() }
    await d.dispatch({ path: '/a2a/intent', bearer: 'k', body: { agent_id: 'cc-s', card } })
    expect(onIntent).toHaveBeenCalledWith({ agent, card: expect.objectContaining({ intent_id: 'i1', topic: '找摄影搭子' }) })

    onIntent.mockClear()
    const badCard = { intent_id: 'i2', kind: 'seek' as const, expires_at: new Date(Date.now() + 60000).toISOString() }  // missing topic
    await d.dispatch({ path: '/a2a/intent', bearer: 'k', body: { agent_id: 'cc-s', card: badCard } })
    expect(onIntent).not.toHaveBeenCalled()
  })
  it('intent envelope: 坏 bearer → onIntent 不被调', async () => {
    const onIntent = vi.fn(async () => ({ intent_id: 'i1', match: 'yes' as const }))
    const d = makeEnvelopeDispatch({
      registry: registry(() => null),
      onReveal: async () => ({ mutual: false }), onLetter: async () => ({ ok: true }), onIntent, log,
    })
    const card = { intent_id: 'i1', kind: 'seek' as const, topic: 'x', expires_at: new Date(Date.now() + 60000).toISOString() }
    await d.dispatch({ path: '/a2a/intent', bearer: 'bad', body: { agent_id: 'cc-s', card } })
    expect(onIntent).not.toHaveBeenCalled()
  })
  it('echo envelope: bearer 验证过(against parsed.agent_id) → onEcho({agent, msg}); 坏 shape drop', async () => {
    const onEcho = vi.fn(async () => ({ ok: true }))
    const agent = rec('cc-s')
    const d = makeEnvelopeDispatch({
      registry: registry((id, b) => (id === 'cc-s' && b === 'k') ? agent : null),
      onReveal: async () => ({ mutual: false }), onLetter: async () => ({ ok: true }), onEcho, log,
    })
    const msg = { agent_id: 'cc-s', intent_id: 'i1', echo: { blurb: '也爱摄影', degree: 1 } }
    await d.dispatch({ path: '/a2a/echo', bearer: 'k', body: msg })
    expect(onEcho).toHaveBeenCalledWith({ agent, msg: expect.objectContaining({ intent_id: 'i1' }) })

    onEcho.mockClear()
    // bad shape (missing echo.blurb) → dropped before bearer is even checked
    await d.dispatch({ path: '/a2a/echo', bearer: 'k', body: { agent_id: 'cc-s', intent_id: 'i1', echo: { degree: 1 } } })
    expect(onEcho).not.toHaveBeenCalled()
  })
  it('echo envelope: 坏 bearer → onEcho 不被调', async () => {
    const onEcho = vi.fn(async () => ({ ok: true }))
    const d = makeEnvelopeDispatch({
      registry: registry(() => null),
      onReveal: async () => ({ mutual: false }), onLetter: async () => ({ ok: true }), onEcho, log,
    })
    const msg = { agent_id: 'cc-s', intent_id: 'i1', echo: { blurb: 'x', degree: 1 } }
    await d.dispatch({ path: '/a2a/echo', bearer: 'bad', body: msg })
    expect(onEcho).not.toHaveBeenCalled()
  })
})
