import { describe, it, expect } from 'vitest'
import { createPublicKey, verify } from 'node:crypto'
import { deriveRendezvous } from './pairing-crypto'
import { sealEnvelope, openEnvelope, signFetch } from './mailbox-crypto'

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
  })

  it('produces an Ed25519 addr node:crypto accepts for sign/verify', () => {
    const id = deriveRendezvous('100200')
    const msg = signFetch(id.sign, id.addr, 1_700_000_000_000)
    // addr is the base64url SPKI-DER Ed25519 pubkey — reconstruct + verify the raw signature.
    const pub = createPublicKey({ key: Buffer.from(id.addr, 'base64url'), format: 'der', type: 'spki' })
    const raw = id.sign(`fetch:${id.addr}:1700000000000`)
    expect(verify(null, Buffer.from(`fetch:${id.addr}:1700000000000`, 'utf8'), pub, Buffer.from(raw, 'base64url'))).toBe(true)
    expect(typeof msg).toBe('string')
  })

  it('produces an X25519 enc keypair sealEnvelope/openEnvelope round-trip through', () => {
    const id = deriveRendezvous('654321')
    const env = sealEnvelope({ path: '/pair', bearer: '', body: { hi: 1 } }, id.enc_pub)
    const inner = openEnvelope(id.enc_priv, env)
    expect(inner).not.toBeNull()
    expect(inner!.body).toEqual({ hi: 1 })
  })
})
