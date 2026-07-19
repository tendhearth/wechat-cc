/**
 * penpal-crypto.ts — the ONLY cryptography module for the anonymous pen-pal
 * channel. Node built-in `node:crypto` exclusively (no new dependency):
 *   - per-connection X25519 keypair (unlinkable across connections)
 *   - shared secret via crypto.diffieHellman
 *   - AES-256 key via HKDF-SHA256 (crypto.hkdfSync)
 *   - each letter sealed with AES-256-GCM + a fresh 12-byte random nonce, authenticated.
 * Keys + ciphertext are stored/transmitted as base64url (URL-safe, no padding).
 * The private key NEVER leaves the machine; only the spki-DER pubkey is crossed
 * at reveal (the PenpalHandle). See docs/superpowers/specs/2026-07-18-anonymous-penpal-social-layer-design.md.
 */
import {
  generateKeyPairSync, createPrivateKey, createPublicKey, diffieHellman,
  hkdfSync, randomBytes, createCipheriv, createDecipheriv,
} from 'node:crypto'

/** A per-connection pseudonym crossed at reveal: an ephemeral pubkey + the
 *  opaque channel id the holder listens on. Contains NO real identity. */
export interface PenpalHandle { pubkey: string; channel_id: string }

/** An AES-256-GCM sealed letter; every field base64url. */
export interface SealedLetter { nonce: string; ct: string; tag: string }

// Domain-separation constants for HKDF — fixed on both sides so the derived key matches.
const HKDF_SALT = Buffer.alloc(0)
const HKDF_INFO = Buffer.from('wechat-cc penpal channel v1')
const KEY_LEN = 32   // AES-256
const NONCE_LEN = 12 // GCM standard

/** Fresh per-connection X25519 keypair. base64url of the DER encodings
 *  (spki for the public handle, pkcs8 for the local-only private key). */
export function generateKeypair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('x25519')
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url'),
  }
}

/** ECDH(my private, peer public) → HKDF-SHA256 → 32-byte AES key. Symmetric:
 *  deriveSharedKey(aPriv, bPub) === deriveSharedKey(bPriv, aPub). */
export function deriveSharedKey(myPriv: string, peerPub: string): Buffer {
  const privateKey = createPrivateKey({ key: Buffer.from(myPriv, 'base64url'), format: 'der', type: 'pkcs8' })
  const publicKey = createPublicKey({ key: Buffer.from(peerPub, 'base64url'), format: 'der', type: 'spki' })
  const shared = diffieHellman({ privateKey, publicKey })
  return Buffer.from(hkdfSync('sha256', shared, HKDF_SALT, HKDF_INFO, KEY_LEN))
}

/** AES-256-GCM seal with a fresh random nonce; returns base64url {nonce,ct,tag}. */
export function sealLetter(key: Buffer, plaintext: string): SealedLetter {
  const nonce = randomBytes(NONCE_LEN)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return { nonce: nonce.toString('base64url'), ct: ct.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') }
}

/** AES-256-GCM open; throws if the tag doesn't authenticate (tamper / wrong key). */
export function openLetter(key: Buffer, sealed: SealedLetter): string {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.nonce, 'base64url'))
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64url'))
  const pt = Buffer.concat([decipher.update(Buffer.from(sealed.ct, 'base64url')), decipher.final()])
  return pt.toString('utf8')
}
