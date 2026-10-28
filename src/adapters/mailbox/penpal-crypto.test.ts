import { describe, it, expect } from 'vitest'
import { generateKeypair, deriveSharedKey, sealLetter, openLetter } from './penpal-crypto'

describe('penpal-crypto — X25519 + HKDF + AES-256-GCM', () => {
  it('two parties derive the SAME symmetric key from crossed pubkeys', () => {
    const a = generateKeypair()
    const b = generateKeypair()
    const kAB = deriveSharedKey(a.privateKey, b.publicKey)
    const kBA = deriveSharedKey(b.privateKey, a.publicKey)
    expect(kAB.equals(kBA)).toBe(true)
    expect(kAB).toHaveLength(32)          // AES-256 key
  })

  it('keys are fresh + unlinkable across connections', () => {
    const a = generateKeypair(); const b = generateKeypair()
    expect(a.publicKey).not.toBe(b.publicKey)
    expect(a.privateKey).not.toBe(b.privateKey)
    // base64url only (no +/=): unlinkable opaque handles
    expect(a.publicKey).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('seal → open round-trips a letter (incl. unicode)', () => {
    const a = generateKeypair(); const b = generateKeypair()
    const key = deriveSharedKey(a.privateKey, b.publicKey)
    const sealed = sealLetter(key, '你好,笔友 👋 见字如面')
    expect(sealed.nonce).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(sealed.ct).not.toContain('见字如面')     // ciphertext, not plaintext
    const opened = openLetter(deriveSharedKey(b.privateKey, a.publicKey), sealed)
    expect(opened).toBe('你好,笔友 👋 见字如面')
  })

  it('a fresh nonce per seal → identical plaintext yields different ciphertext', () => {
    const a = generateKeypair(); const b = generateKeypair()
    const key = deriveSharedKey(a.privateKey, b.publicKey)
    expect(sealLetter(key, 'x').nonce).not.toBe(sealLetter(key, 'x').nonce)
  })

  it('tamper detection — a flipped ciphertext byte throws (GCM auth)', () => {
    const a = generateKeypair(); const b = generateKeypair()
    const key = deriveSharedKey(a.privateKey, b.publicKey)
    const sealed = sealLetter(key, 'secret')
    const buf = Buffer.from(sealed.ct, 'base64url'); buf[0]! ^= 0xff
    const tampered = { ...sealed, ct: buf.toString('base64url') }
    expect(() => openLetter(key, tampered)).toThrow()
  })

  it('wrong key cannot open (no cross-connection leakage)', () => {
    const a = generateKeypair(); const b = generateKeypair(); const c = generateKeypair()
    const sealed = sealLetter(deriveSharedKey(a.privateKey, b.publicKey), 'private')
    expect(() => openLetter(deriveSharedKey(a.privateKey, c.publicKey), sealed)).toThrow()
  })
})
