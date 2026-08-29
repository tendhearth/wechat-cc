/**
 * tunnel-crypto.ts — the end-to-end sealed layer for 随身 CC 的远程中继
 * (2026-08-26, mobile route step 3). Phone ⇄ relay ⇄ daemon: the relay only
 * ever forwards ciphertext frames keyed by an opaque daemon id; it can't read
 * a byte. Both ends run the SAME primitives — daemon via node:crypto, phone
 * via browser WebCrypto — so this file deliberately uses only WebCrypto-
 * portable algorithms:
 *
 *   - X25519 ECDH → a 32-byte shared secret (raw-exportable, browser-native)
 *   - HKDF-SHA256 → a 256-bit AES key
 *   - AES-256-GCM with a fresh 12-byte random nonce per frame (authenticated)
 *
 * Wire frame: { iv, ct } base64url. No dependency — node:crypto.webcrypto ===
 * the browser's crypto.subtle, so the phone page can `import` a JS twin of
 * seal/open verbatim.
 */
import { webcrypto } from 'node:crypto'

// node:crypto's webcrypto types (not the DOM lib's) — avoids CryptoKey/
// BufferSource clashes when the daemon runs under @types/node.
type CryptoKey = webcrypto.CryptoKey
type CryptoKeyPair = webcrypto.CryptoKeyPair
const subtle = webcrypto.subtle as unknown as {
  generateKey(algo: object, extractable: boolean, uses: string[]): Promise<CryptoKeyPair>
  exportKey(fmt: string, key: CryptoKey): Promise<ArrayBuffer>
  importKey(fmt: string, data: Uint8Array, algo: object | string, extractable: boolean, uses: string[]): Promise<CryptoKey>
  deriveBits(algo: object, key: CryptoKey, len: number): Promise<ArrayBuffer>
  deriveKey(algo: object, key: CryptoKey, derived: object, extractable: boolean, uses: string[]): Promise<CryptoKey>
  encrypt(algo: object, key: CryptoKey, data: Uint8Array): Promise<ArrayBuffer>
  decrypt(algo: object, key: CryptoKey, data: Uint8Array): Promise<ArrayBuffer>
}
const HKDF_INFO = new TextEncoder().encode('wechat-cc/tunnel/v1')
const HKDF_SALT = new Uint8Array(0)

export interface TunnelKeypair {
  publicKey: CryptoKey
  privateKey: CryptoKey
}

export interface SealedFrame {
  iv: string  // base64url, 12 bytes
  ct: string  // base64url ciphertext+tag
}

function b64u(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  return Buffer.from(b).toString('base64url')
}
function unb64u(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64url'))
}

export async function generateTunnelKeypair(): Promise<TunnelKeypair> {
  const kp = await subtle.generateKey({ name: 'X25519' }, true, ['deriveKey', 'deriveBits'])
  return { publicKey: kp.publicKey, privateKey: kp.privateKey }
}

export async function exportPublicKeyB64(key: CryptoKey): Promise<string> {
  return b64u(await subtle.exportKey('raw', key))
}

export async function importPublicKeyB64(b64: string): Promise<CryptoKey> {
  return subtle.importKey('raw', unb64u(b64), { name: 'X25519' }, true, [])
}

/** Raw X25519 ECDH bits — the daemon reuses these across candidate binding
 *  secrets so it does ECDH once per stream, not once per known device. */
export async function deriveSharedBits(myPrivate: CryptoKey, theirPublic: CryptoKey): Promise<ArrayBuffer> {
  return subtle.deriveBits({ name: 'X25519', public: theirPublic }, myPrivate, 256)
}

/** HKDF-SHA256(bits, salt=bindSecret) → AES-256-GCM key. The bindSecret is
 *  the tunnel's authentication: mixing the DEVICE TOKEN (which a relay never
 *  sees) into the salt means a relay that substitutes its own X25519 pubkey
 *  derives a DIFFERENT key than the daemon computes — its forged frames fail
 *  GCM auth, defeating the MITM. Empty bindSecret ⇒ unauthenticated (tests). */
export async function hkdfAesKey(bits: ArrayBuffer, bindSecret: Uint8Array = HKDF_SALT): Promise<CryptoKey> {
  const hkdfKey = await subtle.importKey('raw', new Uint8Array(bits), 'HKDF', false, ['deriveKey'])
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: bindSecret.length > 0 ? bindSecret : HKDF_SALT, info: HKDF_INFO },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/** X25519 ECDH → HKDF-SHA256 → AES-256-GCM. `bindSecret` (the device token)
 *  authenticates the channel against a MITM relay — see hkdfAesKey. */
export async function deriveSharedKey(myPrivate: CryptoKey, theirPublic: CryptoKey, bindSecret?: Uint8Array): Promise<CryptoKey> {
  return hkdfAesKey(await deriveSharedBits(myPrivate, theirPublic), bindSecret)
}

export async function sealFrame(key: CryptoKey, plaintext: Uint8Array): Promise<SealedFrame> {
  const iv = webcrypto.getRandomValues(new Uint8Array(12))
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext)
  return { iv: b64u(iv), ct: b64u(ct) }
}

export async function openFrame(key: CryptoKey, frame: SealedFrame): Promise<Uint8Array> {
  const iv = unb64u(frame.iv)
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv }, key, unb64u(frame.ct))
  return new Uint8Array(pt)
}
