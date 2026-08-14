import { describe, it, expect } from 'vitest'
import { createPublicKey, verify } from 'node:crypto'
import { deriveRendezvous } from './pairing-crypto'
import { sealEnvelope, openEnvelope, signFetch } from './mailbox-crypto'
import { verifyFetchSig } from '../../relay/mailbox-auth'

describe('pairing-crypto/deriveRendezvous', () => {
  it('is byte-for-byte deterministic for the same code', () => {
    const a = deriveRendezvous('483921')
    const b = deriveRendezvous('483921')
    expect(a.addr).toBe(b.addr)
    expect(a.enc_pub).toBe(b.enc_pub)
    expect(a.enc_priv).toBe(b.enc_priv)
    expect(a.sign('m')).toBe(b.sign('m'))
  })

  it('differs for a different code', () => {
    const a = deriveRendezvous('483921')
    const b = deriveRendezvous('483922')
    expect(a.addr).not.toBe(b.addr)
    expect(a.enc_pub).not.toBe(b.enc_pub)
    expect(a.enc_priv).not.toBe(b.enc_priv)

    // A's fetch signature must not verify under B's addr — cross-code signatures
    // must not be interchangeable, not even accidentally.
    const ts = 1_700_000_000_000
    const sigFromA = signFetch(a.sign, a.addr, ts)
    expect(verifyFetchSig(b.addr, ts, sigFromA, ts)).toBe(false)
  })

  it('produces an Ed25519 addr node:crypto accepts for sign/verify', () => {
    const id = deriveRendezvous('100200')
    const ts = 1_700_000_000_000
    const sig = signFetch(id.sign, id.addr, ts)
    expect(typeof sig).toBe('string')

    // The relay's REAL verifier (relay/mailbox-auth.ts) must accept a signature
    // produced end-to-end via signFetch — this is what actually runs in prod, not
    // a hand-rolled reconstruction of its message format that could silently drift.
    expect(verifyFetchSig(id.addr, ts, sig, ts)).toBe(true)

    // Negative cases: a different ts (outside the relay's freshness window, and
    // also just a different signed message) or a tampered signature must fail.
    expect(verifyFetchSig(id.addr, ts, sig, ts + 10 * 60_000)).toBe(false)
    const tamperedSig = sig.slice(0, -4) + (sig.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA')
    expect(verifyFetchSig(id.addr, ts, tamperedSig, ts)).toBe(false)

    // Also sanity-check the raw addr is a node:crypto-importable Ed25519 SPKI key,
    // independent of the relay's message-format convention.
    const pub = createPublicKey({ key: Buffer.from(id.addr, 'base64url'), format: 'der', type: 'spki' })
    const raw = id.sign(`fetch:${id.addr}:${ts}`)
    expect(verify(null, Buffer.from(`fetch:${id.addr}:${ts}`, 'utf8'), pub, Buffer.from(raw, 'base64url'))).toBe(true)
  })

  it('produces an X25519 enc keypair sealEnvelope/openEnvelope round-trip through', () => {
    const id = deriveRendezvous('654321')
    const env = sealEnvelope({ path: '/pair', bearer: '', body: { hi: 1 } }, id.enc_pub)
    const inner = openEnvelope(id.enc_priv, env)
    expect(inner).not.toBeNull()
    expect(inner!.body).toEqual({ hi: 1 })
  })
})
