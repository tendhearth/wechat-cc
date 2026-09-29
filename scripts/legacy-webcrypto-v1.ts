/**
 * legacy-webcrypto-v1.ts — 冻结副本:手机隧道 v1 协议最早的 WebCrypto 实现
 * (原 `src/lib/tunnel-crypto.ts` 在 2026-09-29 换成 `@wechat-cc/protocol`
 * 的 noble 版之前那一份,原样搬过来,不做任何逻辑改动)。
 *
 * 只给两处用,别的地方不要 import 这个文件:
 *   - `scripts/gen-tunnel-vectors.ts`:生成 `packages/protocol/vectors/v1.json`
 *     测试向量,必须锚定在 WebCrypto 上 —— 如果改去调 `tunnel-crypto.ts`(现在
 *     已经是 noble 实现),向量就会变成 noble 验证 noble,自己证自己,毫无意义。
 *   - `src/lib/tunnel-crypto-webcrypto-interop.test.ts`:「WebCrypto 一端 ⇄
 *     新实现一端」互通回归钉子里,扮演 WebCrypto 那一端(模拟手机页
 *     `apps/mobile/src/transport.js` 的 `crypto.subtle` 调用序列)。
 *
 * 算法(跟 `src/lib/tunnel-crypto.ts` 的文档注释、`packages/protocol/src/v1.ts`
 * 完全一致,三份互为验证):
 *   X25519 ECDH → HKDF-SHA256(info='wechat-cc/tunnel/v1', salt=bindSecret 或
 *   空)→ AES-256-GCM,帧 `{ iv, ct }` base64url。
 */
import { webcrypto } from 'node:crypto'

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

export interface LegacyTunnelKeypair {
  publicKey: CryptoKey
  privateKey: CryptoKey
}

export interface LegacySealedFrame {
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

export async function legacyGenerateTunnelKeypair(): Promise<LegacyTunnelKeypair> {
  const kp = await subtle.generateKey({ name: 'X25519' }, true, ['deriveKey', 'deriveBits'])
  return { publicKey: kp.publicKey, privateKey: kp.privateKey }
}

export async function legacyExportPublicKeyB64(key: CryptoKey): Promise<string> {
  return b64u(await subtle.exportKey('raw', key))
}

export async function legacyImportPublicKeyB64(b64: string): Promise<CryptoKey> {
  return subtle.importKey('raw', unb64u(b64), { name: 'X25519' }, true, [])
}

export async function legacyDeriveSharedBits(myPrivate: CryptoKey, theirPublic: CryptoKey): Promise<ArrayBuffer> {
  return subtle.deriveBits({ name: 'X25519', public: theirPublic }, myPrivate, 256)
}

export async function legacyHkdfAesKey(bits: ArrayBuffer, bindSecret: Uint8Array = HKDF_SALT): Promise<CryptoKey> {
  const hkdfKey = await subtle.importKey('raw', new Uint8Array(bits), 'HKDF', false, ['deriveKey'])
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: bindSecret.length > 0 ? bindSecret : HKDF_SALT, info: HKDF_INFO },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export async function legacyDeriveSharedKey(myPrivate: CryptoKey, theirPublic: CryptoKey, bindSecret?: Uint8Array): Promise<CryptoKey> {
  return legacyHkdfAesKey(await legacyDeriveSharedBits(myPrivate, theirPublic), bindSecret)
}

export async function legacySealFrame(key: CryptoKey, plaintext: Uint8Array): Promise<LegacySealedFrame> {
  const iv = webcrypto.getRandomValues(new Uint8Array(12))
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext)
  return { iv: b64u(iv), ct: b64u(ct) }
}

export async function legacyOpenFrame(key: CryptoKey, frame: LegacySealedFrame): Promise<Uint8Array> {
  const iv = unb64u(frame.iv)
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv }, key, unb64u(frame.ct))
  return new Uint8Array(pt)
}
