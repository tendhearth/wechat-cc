/**
 * tunnel-crypto.ts — the end-to-end sealed layer for 随身 CC 的远程中继
 * (2026-08-26, mobile route step 3). Phone ⇄ relay ⇄ daemon: the relay only
 * ever forwards ciphertext frames keyed by an opaque daemon id; it can't read
 * a byte. Both ends run the SAME algorithm — the phone via browser WebCrypto
 * (`apps/mobile/src/transport.js`), the daemon here via `@wechat-cc/protocol`
 * (noble, 2026-09-29 — see below) — so the wire format must stay byte-
 * identical no matter which implementation computes it:
 *
 *   - X25519 ECDH → a 32-byte shared secret (raw-exportable, browser-native)
 *   - HKDF-SHA256 → a 256-bit AES key
 *   - AES-256-GCM with a fresh 12-byte random nonce per frame (authenticated)
 *
 * Wire frame: { iv, ct } base64url. Until 2026-09-29 this file WAS the
 * WebCrypto implementation directly (node:crypto.webcrypto === the browser's
 * crypto.subtle, so the phone page could `import` a JS twin verbatim). It now
 * delegates the primitives to `@wechat-cc/protocol` (`@noble/curves` /
 * `@noble/hashes` / `@noble/ciphers`) so the same package can also run inside
 * the mobile app bundle and any other non-browser runtime. The byte-for-byte
 * equivalence with WebCrypto is proven two ways:
 *   - `packages/protocol/vectors/v1.json` — vectors generated from the frozen
 *     WebCrypto original (`scripts/legacy-webcrypto-v1.ts`), checked against
 *     the noble implementation in `packages/protocol/src/v1.test.ts`.
 *   - `src/lib/tunnel-crypto-webcrypto-interop.test.ts` — a live handshake +
 *     request/reply between a real WebCrypto peer (the same frozen module,
 *     standing in for transport.js) and THIS file's exported functions.
 *
 * Exported names/signatures are unchanged from the WebCrypto era so
 * `tunnel-client.ts` and every test importing this module didn't need to
 * change their call shape — only the key TYPES did: `TunnelKeypair`'s
 * `publicKey`/`privateKey`, and the AES key `hkdfAesKey`/`deriveSharedKey`
 * return, are now opaque objects wrapping a raw `Uint8Array` (not WebCrypto
 * `CryptoKey` handles) — callers must keep treating them as opaque and pass
 * them straight through to this module's own functions.
 */
import { x25519KeyPair, x25519Shared, deriveV1Key, sealV1, openV1, b64uEncode, b64uDecode } from '@wechat-cc/protocol'

const HKDF_SALT = new Uint8Array(0)

/** Opaque — internally a raw Uint8Array. Never constructed by hand; always
 *  produced by this module's own functions and passed straight back in. The
 *  `kind` tag exists only to stop TypeScript from structurally confusing a
 *  public key, a private key and a derived AES key with each other. */
export interface TunnelPublicKey { readonly kind: 'tunnel-pub'; readonly raw: Uint8Array }
export interface TunnelPrivateKey { readonly kind: 'tunnel-priv'; readonly raw: Uint8Array }
export interface TunnelSharedKey { readonly kind: 'tunnel-shared-key'; readonly raw: Uint8Array }

export interface TunnelKeypair {
  publicKey: TunnelPublicKey
  privateKey: TunnelPrivateKey
}

export interface SealedFrame {
  iv: string  // base64url, 12 bytes
  ct: string  // base64url ciphertext+tag
}

export async function generateTunnelKeypair(): Promise<TunnelKeypair> {
  const kp = x25519KeyPair()
  return {
    publicKey: { kind: 'tunnel-pub', raw: kp.pub },
    privateKey: { kind: 'tunnel-priv', raw: kp.priv },
  }
}

export async function exportPublicKeyB64(key: TunnelPublicKey): Promise<string> {
  return b64uEncode(key.raw)
}

export async function importPublicKeyB64(b64: string): Promise<TunnelPublicKey> {
  const raw = b64uDecode(b64)
  // X25519 raw public keys are exactly 32 bytes — WebCrypto's `importKey`
  // enforces this (throws DataError otherwise) and callers (tunnel-client.ts's
  // handshake handler) rely on a bad/short pubkey throwing here, not later.
  if (raw.length !== 32) throw new Error(`importPublicKeyB64: expected 32 raw bytes, got ${raw.length}`)
  return { kind: 'tunnel-pub', raw }
}

/** Raw X25519 ECDH bits — the daemon reuses these across candidate binding
 *  secrets so it does ECDH once per stream, not once per known device. */
export async function deriveSharedBits(myPrivate: TunnelPrivateKey, theirPublic: TunnelPublicKey): Promise<ArrayBuffer> {
  const shared = x25519Shared(myPrivate.raw, theirPublic.raw)
  // Copy into a freshly-allocated, tightly-sized buffer — callers (this
  // module's own hkdfAesKey, tunnel-client.ts's per-stream cache) treat the
  // result as a self-contained ArrayBuffer, not a view into something bigger.
  return Uint8Array.from(shared).buffer
}

/** HKDF-SHA256(bits, salt=bindSecret) → AES-256-GCM key. The bindSecret is
 *  the tunnel's authentication: mixing the DEVICE TOKEN (which a relay never
 *  sees) into the salt means a relay that substitutes its own X25519 pubkey
 *  derives a DIFFERENT key than the daemon computes — its forged frames fail
 *  GCM auth, defeating the MITM. Empty bindSecret ⇒ unauthenticated (tests). */
export async function hkdfAesKey(bits: ArrayBuffer, bindSecret: Uint8Array = HKDF_SALT): Promise<TunnelSharedKey> {
  // deriveV1Key's `bind` is a string it UTF-8-encodes itself; bindSecret here
  // is already UTF-8 bytes (every caller builds it via `new
  // TextEncoder().encode(token)`), so decoding back to a string round-trips
  // exactly — TextEncoder/TextDecoder are inverses for any string input.
  const bind = bindSecret.length > 0 ? new TextDecoder().decode(bindSecret) : ''
  const raw = deriveV1Key(new Uint8Array(bits), bind)
  return { kind: 'tunnel-shared-key', raw }
}

/** X25519 ECDH → HKDF-SHA256 → AES-256-GCM. `bindSecret` (the device token)
 *  authenticates the channel against a MITM relay — see hkdfAesKey. */
export async function deriveSharedKey(myPrivate: TunnelPrivateKey, theirPublic: TunnelPublicKey, bindSecret?: Uint8Array): Promise<TunnelSharedKey> {
  return hkdfAesKey(await deriveSharedBits(myPrivate, theirPublic), bindSecret)
}

export async function sealFrame(key: TunnelSharedKey, plaintext: Uint8Array): Promise<SealedFrame> {
  return sealV1(key.raw, plaintext)
}

export async function openFrame(key: TunnelSharedKey, frame: SealedFrame): Promise<Uint8Array> {
  return openV1(key.raw, frame)
}
