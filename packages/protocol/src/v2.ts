/**
 * v2.ts — 手机隧道 v2:双向独立密钥 + 计数器 nonce + 防重放。
 *
 * 跟 v1(见 `v1.ts`)的区别:
 *   - v1 一把对称密钥两个方向共用,iv 随机;v2 每个方向各推一把密钥
 *     (HKDF info 后缀 `/c2s` `/s2c`),nonce 由「方向标记 + 严格递增的计数
 *     器」确定性拼出,不需要随机数,天然杜绝“两端用同一把密钥挑同一个
 *     随机 iv 撞上”的那类 nonce 复用事故。
 *   - 计数器天然给了防重放:收方记住“已接受的最大计数器”,新帧的 `c`
 *     必须严格更大,否则拒收(重放或乱序都归为 `replay`)。
 *
 * nonce(12 字节)= 4 字节大端方向标记(c2s=1,s2c=2)+ 8 字节大端计数器。
 * 计数器上限钉在 `Number.MAX_SAFE_INTEGER`(2^53-1):到这个值 `seal` 直接
 * 抛错,不回绕 —— 回绕等于亲手把 nonce 复用送回来。
 */
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { gcm } from '@noble/ciphers/aes.js'
import { b64uEncode, b64uDecode } from './b64u'

const HKDF_INFO_C2S = new TextEncoder().encode('wechat-cc/tunnel/v2/c2s')
const HKDF_INFO_S2C = new TextEncoder().encode('wechat-cc/tunnel/v2/s2c')
const EMPTY_SALT = new Uint8Array(0)

const MARKER_C2S = 1
const MARKER_S2C = 2

/** c 的合法形式:纯十进制、无符号、无前导零(除了单独的 "0")、无小数/指数。 */
const COUNTER_RE = /^(0|[1-9][0-9]*)$/

/** HKDF-SHA256(shared, salt=utf8(bind) 或空, info='wechat-cc/tunnel/v2/{c2s|s2c}') → 两把 32 字节 AES 密钥。 */
export function deriveV2Keys(shared: Uint8Array, bind: string): { c2s: Uint8Array; s2c: Uint8Array } {
  const salt = bind.length > 0 ? new TextEncoder().encode(bind) : EMPTY_SALT
  return {
    c2s: hkdf(sha256, shared, salt, HKDF_INFO_C2S, 32),
    s2c: hkdf(sha256, shared, salt, HKDF_INFO_S2C, 32),
  }
}

export interface SealedFrameV2 {
  c: string // 计数器,十进制字符串(无前导零、无符号)
  ct: string // base64url,密文 + 16 字节 GCM tag
}

export interface V2Channel {
  seal(pt: Uint8Array): SealedFrameV2
  /** 认证失败(篡改/方向或密钥不对/畸形 c 或 ct)⇒ 抛 Error('auth');计数器不严格递增 ⇒ 抛 Error('replay')。 */
  open(f: SealedFrameV2): Uint8Array
}

function buildNonce(marker: number, counter: number): Uint8Array {
  const nonce = new Uint8Array(12)
  const view = new DataView(nonce.buffer)
  view.setUint32(0, marker, false)
  view.setBigUint64(4, BigInt(counter), false)
  return nonce
}

/**
 * `open` 收到的帧是从线上(JSON.parse 之后)来的,类型不可信 —— 光靠
 * `SealedFrameV2` 的编译期类型标注挡不住运行时传来 `c: 0`(number)、
 * `c: [5]`、缺字段、整帧是 `null`/字符串这类畸形输入。逐字段检查形状,
 * 在碰 `c`/`ct` 的任何值之前就拒绝,不让它们有机会被隐式转换后蒙混过
 * `COUNTER_RE.test()`(正则的 `.test()` 会把非字符串参数强转成字符串,
 * `0` 会变成 `"0"` 从而“合法”通过 —— 这正是这个校验要堵的洞)。
 */
function assertFrameShape(f: unknown): asserts f is SealedFrameV2 {
  if (typeof f !== 'object' || f === null || Array.isArray(f)) {
    throw new Error('auth')
  }
  const rec = f as Record<string, unknown>
  if (typeof rec.c !== 'string' || typeof rec.ct !== 'string') {
    throw new Error('auth')
  }
}

/** 解析 `c`:格式不对或超出安全整数范围 ⇒ 抛 'auth'(畸形输入,不是重放)。 */
function parseCounter(c: string): number {
  if (!COUNTER_RE.test(c)) {
    throw new Error('auth')
  }
  const n = Number(c)
  if (!Number.isSafeInteger(n)) {
    throw new Error('auth')
  }
  return n
}

/**
 * `opts.startSendCounter` 只给测试用,用来把计数器直接摆到接近
 * `Number.MAX_SAFE_INTEGER` 的地方验证溢出拒收 —— 真实调用一律不传,
 * 从 0 起步。
 */
export function makeV2Channel(
  keys: { c2s: Uint8Array; s2c: Uint8Array },
  side: 'client' | 'server',
  opts?: { startSendCounter?: number },
): V2Channel {
  const sealKey = side === 'client' ? keys.c2s : keys.s2c
  const sealMarker = side === 'client' ? MARKER_C2S : MARKER_S2C
  const openKey = side === 'client' ? keys.s2c : keys.c2s
  const openMarker = side === 'client' ? MARKER_S2C : MARKER_C2S

  let sendCounter = opts?.startSendCounter ?? 0
  let lastAccepted = -1 // 还没接受过任何帧;第一帧只要 c >= 0 就满足“严格更大”

  return {
    seal(pt: Uint8Array): SealedFrameV2 {
      if (sendCounter >= Number.MAX_SAFE_INTEGER) {
        throw new Error('counter overflow')
      }
      const c = sendCounter
      sendCounter += 1
      const nonce = buildNonce(sealMarker, c)
      const ct = gcm(sealKey, nonce).encrypt(pt)
      return { c: c.toString(10), ct: b64uEncode(ct) }
    },

    open(f: SealedFrameV2): Uint8Array {
      assertFrameShape(f)
      const c = parseCounter(f.c)
      if (c <= lastAccepted) {
        throw new Error('replay')
      }
      let ct: Uint8Array
      try {
        ct = b64uDecode(f.ct)
      } catch {
        throw new Error('auth')
      }
      const nonce = buildNonce(openMarker, c)
      let pt: Uint8Array
      try {
        pt = gcm(openKey, nonce).decrypt(ct)
      } catch {
        throw new Error('auth')
      }
      // 只有认证通过才推进接收计数器 —— 篡改帧不能把合法的老计数器挤掉。
      lastAccepted = c
      return pt
    },
  }
}
