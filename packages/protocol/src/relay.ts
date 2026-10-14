/**
 * relay.ts — 官方中继 v2(Cloudflare,spec 2026-09-30)的身份与控制帧。Worker 与 daemon 共用。
 *
 * daemon 身份:Ed25519。id = 'r' + base32小写(sha256(公钥原始 32 字节)) 前 26 字符 —— id 由公钥
 * 派生,中继不需要另存「这个 id 属于哪把钥匙」,冒名者拿不出能派生出该 id 的公钥。
 * 登录:房间发 {challenge, ts};daemon 回 {pub, sig},签 UTF-8 `wechat-cc/relay/v2/login:<challenge>:<id>`。
 *
 * 纯净约束(protocol-purity 守卫):不用 Node 模块、TypedArrays 的 buffer 成员、Web Crypto subtle API;随机数走 getRandomValues。
 */
import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import z from 'zod'
import { b64uDecode, b64uEncode } from './b64u'

const B32 = 'abcdefghijklmnopqrstuvwxyz234567'

export function base32Lower(bytes: Uint8Array): string {
  let out = ''
  let bits = 0
  let value = 0
  for (const b of bytes) {
    value = ((value << 8) | b) & 0xffff
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

export const RELAY_ID_RE = /^r[a-z2-7]{26}$/
export const RELAY_SUBPROTOCOL = 'wcc.relay.v2'
export const relayIdProtocol = (id: string): string => `id.${id}`

export function relayIdFromPub(pub: Uint8Array): string {
  if (pub.length !== 32) throw new Error('relay_pub_length')
  return 'r' + base32Lower(sha256(pub)).slice(0, 26)
}

export function relayKeyPair(seed?: Uint8Array): { seed: Uint8Array; pub: Uint8Array } {
  const s = seed ?? crypto.getRandomValues(new Uint8Array(32))
  return { seed: s, pub: ed25519.getPublicKey(s) }
}

export function relayLoginMessage(challenge: string, daemonId: string): Uint8Array {
  return new TextEncoder().encode(`wechat-cc/relay/v2/login:${challenge}:${daemonId}`)
}

export function signRelayLogin(seed: Uint8Array, challenge: string, daemonId: string): { pub: string; sig: string } {
  const pub = ed25519.getPublicKey(seed)
  const sig = ed25519.sign(relayLoginMessage(challenge, daemonId), seed)
  return { pub: b64uEncode(pub), sig: b64uEncode(sig) }
}

export function verifyRelayLogin(daemonId: string, challenge: string, pub: string, sig: string): boolean {
  try {
    const pubBytes = b64uDecode(pub)
    if (relayIdFromPub(pubBytes) !== daemonId) return false
    return ed25519.verify(b64uDecode(sig), relayLoginMessage(challenge, daemonId), pubBytes)
  } catch {
    return false
  }
}

export const RELAY_ERRORS = ['daemon_offline', 'frame_too_large', 'rate_limited', 'quota_exceeded', 'too_many_streams', 'login_failed', 'handshake_timeout'] as const
export type RelayError = (typeof RELAY_ERRORS)[number]

/** apns_sandbox:Xcode 调试包拿到的是沙盒 token,要打 api.sandbox.push.apple.com(计划裁决 1)。 */
export const PushPlatform = z.enum(['apns', 'apns_sandbox', 'fcm'])
export type PushPlatformT = z.infer<typeof PushPlatform>

export function pushTokenValid(platform: PushPlatformT, token: string): boolean {
  if (platform === 'fcm') return /^[A-Za-z0-9:_-]{20,4096}$/.test(token)
  return /^[0-9a-fA-F]{64,200}$/.test(token)
}

export const PUSH_SEALED_MAX_CHARS = 3500
const Device = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
const Ref = z.string().max(64)
const SealedPushShape = z.object({ v: z.literal(1), iv: z.string().max(64), ct: z.string().max(PUSH_SEALED_MAX_CHARS) })

/** 推送权威清单的上限(房间自己最多存 20 个登记;留余量给「本地比房间多」的情形)。 */
export const PUSH_SYNC_MAX_DEVICES = 64

/**
 * daemon → 房间的控制帧(没有 `stream` 字段的那些)。
 *
 * 流帧不在这里:`{stream, frame}` 转给那条手机流;`{stream, close:true}` 请房间关掉那条手机流、
 * 立刻腾出名额(daemon 认证失败并已把 `{error:'auth_failed'}` 作为帧发过去之后发)。
 * `push_sync`:daemon 每次登录后先发的权威设备清单 —— 房间删掉不在单子上的所有 `reg:*`,再逐个 push_reg。
 */
export const DaemonControl = z.union([
  z.object({ pub: z.string().max(128), sig: z.string().max(256) }),
  z.object({ push_reg: z.object({ device: Device, platform: PushPlatform, token: z.string().max(4096) }) }),
  z.object({ push_unreg: z.object({ device: Device }) }),
  z.object({ push_sync: z.object({ devices: z.array(Device).max(PUSH_SYNC_MAX_DEVICES) }) }),
  z.object({ push: z.object({ device: Device, sealed: SealedPushShape, collapseId: z.string().max(64).optional(), ref: Ref.optional() }) }),
])
export type DaemonControlT = z.infer<typeof DaemonControl>

export const RoomControl = z.union([
  z.object({ challenge: z.string(), ts: z.number() }),
  z.object({ login_ok: z.literal(true) }),
  z.object({ push_result: z.object({ device: Device, ok: z.boolean(), code: z.string(), ref: Ref.optional() }) }),
  z.object({ push_invalid: z.object({ device: Device }) }),
  z.object({ error: z.string() }),
])
export type RoomControlT = z.infer<typeof RoomControl>
