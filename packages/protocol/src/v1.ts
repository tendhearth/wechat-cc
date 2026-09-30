/**
 * v1.ts — 手机隧道 v1 密封帧,noble 实现。跟 `src/lib/tunnel-crypto.ts`
 * (daemon 现在用的 WebCrypto 版)线格式字节级兼容:
 *
 *   X25519 ECDH raw 32 字节 → HKDF-SHA256(info='wechat-cc/tunnel/v1',
 *   salt=utf8(bind) 或(bind 为空串时)空 salt) → AES-256-GCM 密钥;帧
 *   `{ iv, ct }` base64url,iv 12 字节,ct 含 16 字节 tag(GCM 缺省 tag 长度,
 *   跟 WebCrypto 一致)。
 *
 * 已配对的手机在真机上跑的是 WebCrypto 那份;这里换成 noble 不能改变任何一
 * 个字节 —— 证据是 `packages/protocol/vectors/v1.json`(用 WebCrypto 生成)
 * 与 `v1.test.ts`。
 */
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { gcm } from '@noble/ciphers/aes.js'
import { b64uEncode, b64uDecode } from './b64u'

const HKDF_INFO = new TextEncoder().encode('wechat-cc/tunnel/v1')
const EMPTY_SALT = new Uint8Array(0)

function randomBytes(len: number): Uint8Array {
  const out = new Uint8Array(len)
  crypto.getRandomValues(out)
  return out
}

/** HKDF-SHA256(shared, salt=utf8(bind) 或空, info='wechat-cc/tunnel/v1') → 32 字节 AES 密钥。 */
export function deriveV1Key(shared: Uint8Array, bind: string): Uint8Array {
  const salt = bind.length > 0 ? new TextEncoder().encode(bind) : EMPTY_SALT
  return hkdf(sha256, shared, salt, HKDF_INFO, 32)
}

export interface SealedFrameV1 {
  iv: string // base64url,12 字节
  ct: string // base64url,密文 + 16 字节 GCM tag
}

/** 不传 `iv` ⇒ 用 `globalThis.crypto.getRandomValues` 现生成 12 字节随机 nonce。 */
export function sealV1(key: Uint8Array, plaintext: Uint8Array, iv?: Uint8Array): SealedFrameV1 {
  const nonce = iv ?? randomBytes(12)
  const ct = gcm(key, nonce).encrypt(plaintext)
  return { iv: b64uEncode(nonce), ct: b64uEncode(ct) }
}

/** 认证失败(tag 不匹配、篡改)⇒ 抛错,跟 WebCrypto 的 `decrypt` 一样。 */
export function openV1(key: Uint8Array, frame: SealedFrameV1): Uint8Array {
  const iv = b64uDecode(frame.iv)
  const ct = b64uDecode(frame.ct)
  return gcm(key, iv).decrypt(ct)
}
