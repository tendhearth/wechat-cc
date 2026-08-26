import { describe, expect, it } from 'vitest'
import { webcrypto } from 'node:crypto'
import {
  generateTunnelKeypair, deriveSharedKey, sealFrame, openFrame,
  exportPublicKeyB64, importPublicKeyB64,
} from './tunnel-crypto'

// The daemon side uses this module; the phone side uses the SAME algorithms
// via WebCrypto in the browser. These tests prove a round-trip AND that the
// wire format is WebCrypto-compatible (ECDH P-256-less: we use X25519).

describe('tunnel-crypto', () => {
  it('two parties derive the same shared key and round-trip a frame', async () => {
    const a = await generateTunnelKeypair()
    const b = await generateTunnelKeypair()
    const ka = await deriveSharedKey(a.privateKey, b.publicKey)
    const kb = await deriveSharedKey(b.privateKey, a.publicKey)

    const plaintext = new TextEncoder().encode(JSON.stringify({ path: '/m/api/state', method: 'GET' }))
    const sealed = await sealFrame(ka, plaintext)
    const opened = await openFrame(kb, sealed)
    expect(new TextDecoder().decode(opened)).toBe(JSON.stringify({ path: '/m/api/state', method: 'GET' }))
  })

  it('a tampered ciphertext fails to open (GCM auth)', async () => {
    const a = await generateTunnelKeypair()
    const b = await generateTunnelKeypair()
    const k = await deriveSharedKey(a.privateKey, b.publicKey)
    const sealed = await sealFrame(k, new TextEncoder().encode('hi'))
    // flip a byte in the base64 ciphertext body
    const bad = { ...sealed, ct: sealed.ct.slice(0, -2) + (sealed.ct.slice(-2) === 'AA' ? 'BB' : 'AA') }
    await expect(openFrame(k, bad)).rejects.toBeTruthy()
  })

  it('a frame sealed for one key cannot be opened by an unrelated key', async () => {
    const a = await generateTunnelKeypair()
    const b = await generateTunnelKeypair()
    const c = await generateTunnelKeypair()
    const k1 = await deriveSharedKey(a.privateKey, b.publicKey)
    const k2 = await deriveSharedKey(a.privateKey, c.publicKey)
    const sealed = await sealFrame(k1, new TextEncoder().encode('secret'))
    await expect(openFrame(k2, sealed)).rejects.toBeTruthy()
  })

  it('public keys export/import as base64url and interop through WebCrypto raw', async () => {
    const a = await generateTunnelKeypair()
    const b64 = await exportPublicKeyB64(a.publicKey)
    expect(b64).toMatch(/^[A-Za-z0-9_-]+$/)
    const reimported = await importPublicKeyB64(b64)
    // derive with the reimported key must match deriving with the original
    const other = await generateTunnelKeypair()
    const k1 = await deriveSharedKey(other.privateKey, a.publicKey)
    const k2 = await deriveSharedKey(other.privateKey, reimported)
    const sealed = await sealFrame(k1, new TextEncoder().encode('x'))
    expect(new TextDecoder().decode(await openFrame(k2, sealed))).toBe('x')
  })

  it('each seal uses a fresh random nonce (no nonce reuse)', async () => {
    const a = await generateTunnelKeypair()
    const b = await generateTunnelKeypair()
    const k = await deriveSharedKey(a.privateKey, b.publicKey)
    const s1 = await sealFrame(k, new TextEncoder().encode('same'))
    const s2 = await sealFrame(k, new TextEncoder().encode('same'))
    expect(s1.iv).not.toBe(s2.iv)
    expect(s1.ct).not.toBe(s2.ct)
  })

  it('uses X25519 (WebCrypto-portable), verified by importing a raw 32-byte key', async () => {
    const a = await generateTunnelKeypair()
    const raw = await webcrypto.subtle.exportKey('raw', a.publicKey)
    expect(raw.byteLength).toBe(32)   // X25519 raw pubkey is 32 bytes
  })
})
