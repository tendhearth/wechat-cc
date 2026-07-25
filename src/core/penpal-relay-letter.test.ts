import { describe, it, expect, vi } from 'vitest'
import { openDb } from '../lib/db'
import { makeRelayStore } from './social-relay-store'
import { makeLetterRelay } from './penpal-relay-letter'

describe('makeLetterRelay', () => {
  it('forwards a sealed relay letter byte-identical to the far peer, addressed by its own channel_id (S -> W -> Q)', async () => {
    const db = openDb({ path: ':memory:' })
    const relayStore = makeRelayStore(db)
    relayStore.create({ id: 'i1:tok', intentId: 'i1', relayToken: 'tok', upstreamAgentId: 'ccs', downstreamAgentId: 'ccq' })
    relayStore.setUpstreamHandle('i1:tok', { pubkey: 'Spub', channel_id: 'chan-s' })
    relayStore.setDownstreamHandle('i1:tok', { pubkey: 'Qpub', channel_id: 'chan-q' })

    const postLetter = vi.fn().mockResolvedValue(true)
    const relay = makeLetterRelay({ relayStore, postLetter })

    const sealed = { nonce: 'N1', ct: 'CIPHERTEXT', tag: 'TAG1' }
    const result = await relay.routeLetter({ agent_id: 'ccs', channel_id: 'chan-q', ...sealed })

    expect(result).toEqual({ ok: true })
    expect(postLetter).toHaveBeenCalledTimes(1)
    const [target, body] = postLetter.mock.calls[0]!
    expect(target).toEqual({ agentId: 'ccq', relayVia: null })
    // byte-identical: same sealed fields, addressed to the far peer's own channel_id
    expect(body).toEqual({ channel_id: 'chan-q', ...sealed })
  })

  it('forwards the other direction too (Q -> W -> S)', async () => {
    const db = openDb({ path: ':memory:' })
    const relayStore = makeRelayStore(db)
    relayStore.create({ id: 'i1:tok', intentId: 'i1', relayToken: 'tok', upstreamAgentId: 'ccs', downstreamAgentId: 'ccq' })
    relayStore.setUpstreamHandle('i1:tok', { pubkey: 'Spub', channel_id: 'chan-s' })
    relayStore.setDownstreamHandle('i1:tok', { pubkey: 'Qpub', channel_id: 'chan-q' })

    const postLetter = vi.fn().mockResolvedValue(true)
    const relay = makeLetterRelay({ relayStore, postLetter })

    const sealed = { nonce: 'N2', ct: 'CIPHERTEXT2', tag: 'TAG2' }
    const result = await relay.routeLetter({ agent_id: 'ccq', channel_id: 'chan-s', ...sealed })

    expect(result).toEqual({ ok: true })
    const [target, body] = postLetter.mock.calls[0]!
    expect(target).toEqual({ agentId: 'ccs', relayVia: null })
    expect(body).toEqual({ channel_id: 'chan-s', ...sealed })
  })

  it('is a safe no-op on an unknown channel_id (no matching relay leg) — no crash, no forward', async () => {
    const db = openDb({ path: ':memory:' })
    const relayStore = makeRelayStore(db)
    const postLetter = vi.fn()
    const relay = makeLetterRelay({ relayStore, postLetter })

    const result = await relay.routeLetter({ agent_id: 'ccs', channel_id: 'nobody-listens-here', nonce: 'N', ct: 'CT', tag: 'TAG' })

    expect(result).toEqual({ ok: false, error: 'unknown_channel' })
    expect(postLetter).not.toHaveBeenCalled()
  })

  it('over-budget sender: drops before postLetter, response is INDISTINGUISHABLE from "unknown channel" (no signal to the sender)', async () => {
    const db = openDb({ path: ':memory:' })
    const relayStore = makeRelayStore(db)
    relayStore.create({ id: 'i1:tok', intentId: 'i1', relayToken: 'tok', upstreamAgentId: 'ccs', downstreamAgentId: 'ccq' })
    relayStore.setUpstreamHandle('i1:tok', { pubkey: 'Spub', channel_id: 'chan-s' })
    relayStore.setDownstreamHandle('i1:tok', { pubkey: 'Qpub', channel_id: 'chan-q' })

    const postLetter = vi.fn().mockResolvedValue(true)
    const withinBudget = vi.fn(() => false)
    const relay = makeLetterRelay({ relayStore, postLetter, withinBudget })

    const result = await relay.routeLetter({ agent_id: 'ccs', channel_id: 'chan-q', nonce: 'N', ct: 'CT', tag: 'TAG' })

    // MUST equal the SAME shape as the existing "no matching relay leg" drop
    // (see the 'is a safe no-op on an unknown channel_id' test above) — a
    // distinct 'over_budget' string would leak the throttle to the sender
    // once /a2a/letter echoes this result back over HTTP 200 (a2a-server.ts).
    expect(result).toEqual({ ok: false, error: 'unknown_channel' })
    expect(withinBudget).toHaveBeenCalledWith('ccs')
    expect(postLetter).not.toHaveBeenCalled()
  })

  it('within-budget sender: forwards as normal', async () => {
    const db = openDb({ path: ':memory:' })
    const relayStore = makeRelayStore(db)
    relayStore.create({ id: 'i1:tok', intentId: 'i1', relayToken: 'tok', upstreamAgentId: 'ccs', downstreamAgentId: 'ccq' })
    relayStore.setUpstreamHandle('i1:tok', { pubkey: 'Spub', channel_id: 'chan-s' })
    relayStore.setDownstreamHandle('i1:tok', { pubkey: 'Qpub', channel_id: 'chan-q' })

    const postLetter = vi.fn().mockResolvedValue(true)
    const relay = makeLetterRelay({ relayStore, postLetter, withinBudget: () => true })

    const result = await relay.routeLetter({ agent_id: 'ccs', channel_id: 'chan-q', nonce: 'N', ct: 'CT', tag: 'TAG' })
    expect(result).toEqual({ ok: true })
    expect(postLetter).toHaveBeenCalledTimes(1)
  })

  it('withinBudget omitted — allow-all default, existing behavior unchanged', async () => {
    const db = openDb({ path: ':memory:' })
    const relayStore = makeRelayStore(db)
    relayStore.create({ id: 'i1:tok', intentId: 'i1', relayToken: 'tok', upstreamAgentId: 'ccs', downstreamAgentId: 'ccq' })
    relayStore.setUpstreamHandle('i1:tok', { pubkey: 'Spub', channel_id: 'chan-s' })
    relayStore.setDownstreamHandle('i1:tok', { pubkey: 'Qpub', channel_id: 'chan-q' })

    const postLetter = vi.fn().mockResolvedValue(true)
    const relay = makeLetterRelay({ relayStore, postLetter })

    const result = await relay.routeLetter({ agent_id: 'ccs', channel_id: 'chan-q', nonce: 'N', ct: 'CT', tag: 'TAG' })
    expect(result).toEqual({ ok: true })
    expect(postLetter).toHaveBeenCalledTimes(1)
  })
})
