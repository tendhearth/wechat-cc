import { describe, it, expect } from 'vitest'
import { generateKeyPairSync, sign as edSign, createPrivateKey } from 'node:crypto'
import { verifyFetchSig, verifyAckSig } from './mailbox-auth'

// Build a real Ed25519 identity the way mailbox-crypto (Task 4) will.
function identity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const addr = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')
  const privDer = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url')
  const sign = (m: string) => edSign(null, Buffer.from(m, 'utf8'),
    createPrivateKey({ key: Buffer.from(privDer, 'base64url'), format: 'der', type: 'pkcs8' })).toString('base64url')
  return { addr, sign }
}

describe('mailbox-auth', () => {
  it('accepts a fresh, correctly-signed fetch and ack', () => {
    const id = identity(); const now = 1_700_000_000_000
    expect(verifyFetchSig(id.addr, now, id.sign(`fetch:${id.addr}:${now}`), now)).toBe(true)
    expect(verifyAckSig(id.addr, 42, now, id.sign(`ack:${id.addr}:42:${now}`), now)).toBe(true)
  })
  it('rejects a wrong signer, a tampered cursor, and a stale ts', () => {
    const id = identity(); const other = identity(); const now = 1_700_000_000_000
    expect(verifyFetchSig(id.addr, now, other.sign(`fetch:${id.addr}:${now}`), now)).toBe(false)   // wrong signer
    expect(verifyAckSig(id.addr, 99, now, id.sign(`ack:${id.addr}:42:${now}`), now)).toBe(false)    // cursor tamper
    expect(verifyFetchSig(id.addr, now, id.sign(`fetch:${id.addr}:${now}`), now + 600_000)).toBe(false) // stale
  })
  it('never throws on garbage pubkey/sig', () => {
    expect(verifyFetchSig('not-a-key', 1, 'nope', 1)).toBe(false)
  })
})
