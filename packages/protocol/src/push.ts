/**
 * push.ts — 离线推送密钥与密封载荷。
 *
 * 手机不在线时(没连着隧道),home daemon 用一把「每设备一把」的推送密钥把
 * 一小段载荷(需要批准了、任务做完了)加密,交给官方 relay 转给 APNs/FCM;
 * relay 和 Apple/Google 都看不到明文,只有手机通知扩展本地解开。这份文件只
 * 管密钥推导和 seal/open,真正的发送是后续子项目。
 *
 * `derivePushKey`:HKDF-SHA256(ikm=utf8(deviceToken), salt=空, info='wechat-cc/push/v1')
 * → 32 字节 AES 密钥。跟 v1/v2 隧道密钥的推导刻意不同(ikm 换成设备令牌本身而不是
 * X25519 共享密钥,info 换成独立命名空间),同一个令牌在推送与隧道两条线上也不会
 * 撞出同一把密钥。
 *
 * `SealedPush`:`{ v: 1, iv, ct }`,iv/ct 跟 v1 隧道帧一样是 base64url 无填充;
 * iv 12 字节随机数(`globalThis.crypto.getRandomValues`),ct 是 AES-256-GCM 对
 * 载荷 UTF-8 JSON 加密后的密文(含 16 字节 tag)。
 *
 * `openPush` 对着不可信的线上输入(relay 转发、可能被篡改或重放),逐层拒绝:
 * 不是对象、v 不是 1、iv/ct 不是字符串、base64 解不出来、GCM 认证失败、解出来
 * 的明文不是 JSON 对象、`ts` 缺失或不是有限数字 ⇒ 一律抛 `Error`;`ts` 早于
 * `now - 1 小时` 或晚于 `now + 10 分钟` ⇒ 抛 `Error('stale')`。窗口:过去 1 小时
 * (APNs/FCM 的 TTL)/ 未来 10 分钟(只容忍时钟偏差);通知只显示不执行,所以放宽
 * 过去方向不引入权限风险;去重在手机端按 ts + 密文哈希做。
 */
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { gcm } from '@noble/ciphers/aes.js'
import { b64uEncode, b64uDecode } from './b64u'

const HKDF_INFO = new TextEncoder().encode('wechat-cc/push/v1')
const EMPTY_SALT = new Uint8Array(0)
/** APNs / FCM 的 TTL 是 1 小时:比它更早的通知本来就不会送达。 */
export const PUSH_MAX_AGE_MS = 3_600_000
/** 未来方向只容忍时钟偏差。 */
export const PUSH_MAX_SKEW_MS = 600_000

function randomBytes(len: number): Uint8Array {
  const out = new Uint8Array(len)
  crypto.getRandomValues(out)
  return out
}

/** HKDF-SHA256(ikm=utf8(deviceToken), salt=空, info='wechat-cc/push/v1') → 32 字节 AES 密钥。 */
export function derivePushKey(deviceToken: string): Uint8Array {
  const ikm = new TextEncoder().encode(deviceToken)
  return hkdf(sha256, ikm, EMPTY_SALT, HKDF_INFO, 32)
}

export interface SealedPush {
  v: 1
  iv: string // base64url,12 字节
  ct: string // base64url,载荷 JSON 的密文 + 16 字节 GCM tag
}

/** 不传 `iv` ⇒ 用 `globalThis.crypto.getRandomValues` 现生成 12 字节随机 nonce。 */
export function sealPush(
  key: Uint8Array,
  payload: { ts: number; [k: string]: unknown },
  iv?: Uint8Array,
): SealedPush {
  const nonce = iv ?? randomBytes(12)
  const plaintext = new TextEncoder().encode(JSON.stringify(payload))
  const ct = gcm(key, nonce).encrypt(plaintext)
  return { v: 1, iv: b64uEncode(nonce), ct: b64uEncode(ct) }
}

/**
 * `sealed` 来自 relay 转发(不可信),类型不可信 —— 逐字段检查形状,在碰
 * `iv`/`ct` 的任何值之前就拒绝畸形输入,而不是让它们隐式转换后蒙混过去。
 */
function assertSealedShape(f: unknown): asserts f is { v: unknown; iv: unknown; ct: unknown } {
  if (typeof f !== 'object' || f === null || Array.isArray(f)) {
    throw new Error('malformed push payload')
  }
}

export function openPush(key: Uint8Array, sealed: SealedPush, now: number): Record<string, unknown> {
  assertSealedShape(sealed)
  const rec = sealed as unknown as Record<string, unknown>
  if (rec.v !== 1) {
    throw new Error('malformed push payload: v')
  }
  if (typeof rec.iv !== 'string' || typeof rec.ct !== 'string') {
    throw new Error('malformed push payload: iv/ct')
  }

  const iv = b64uDecode(rec.iv)
  const ct = b64uDecode(rec.ct)
  const pt = gcm(key, iv).decrypt(ct)

  const text = new TextDecoder().decode(pt)
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('malformed push payload: plaintext not a JSON object')
  }
  const payload = parsed as Record<string, unknown>

  const ts = payload.ts
  if (typeof ts !== 'number' || !Number.isFinite(ts)) {
    throw new Error('malformed push payload: ts')
  }
  if (ts < now - PUSH_MAX_AGE_MS || ts > now + PUSH_MAX_SKEW_MS) {
    throw new Error('stale')
  }

  return payload
}
