/**
 * messages.ts — 手机隧道线上消息的形状。线上来的一切都不可信:收方
 * 先 `safeParse`,不合形状就丢(记一笔协议错误),永远不往外抛。
 *
 * 分两层:
 *   1. 明文帧(握手、控制错误)与密封帧外壳 —— 这些直接走 WebSocket。
 *   2. 密封帧里面的 v2 消息 —— 以 `t` 区分的判别联合。
 *
 * v1(随机 nonce、一把密钥两个方向共用)2026-10-25 退休(架构终态 F4):daemon 收到不带
 * `v:[…2]` 的握手只回明文 `{error:'upgrade_required'}`。
 *
 * 不用 zod:这份文件被打进手机网页与公网壳页的 IIFE(browser.ts → client.ts → 这里),完整版 zod 会把
 * 整页撑出中继一帧,`zod/mini` 跟完整版同进一个编译包时初始化会坏 —— 用 shape.ts 的十几行组合子
 * (只有 `parse` / `safeParse`,语义见那份文件头)。
 */
import * as s from './shape'
import type { Infer } from './shape'
import { b64uEncode, b64uDecode } from './b64u'

// ── 明文帧 ───────────────────────────────────────────────────────────────

/**
 * 客户端握手:裸 X25519 公钥(base64url)+ 支持的版本列表(现在只有 `[2]`;老 App 发 `[1,2]`)。
 * `client: 'web'`:浏览器 /m 页自报(只用来记「一件事的出生地」,见 src/features/phone/phone-client.ts);不带 ⇒ 原生 App。
 */
export const ClientHello = s.object({ hs: s.string(), v: s.optional(s.array(s.int())), client: s.optional(s.literal('web')) })
export type ClientHelloT = Infer<typeof ClientHello>

/** 后台握手回应:`v` 不是 2(老后台只会 v1,或中继剥掉了 `v`)⇒ 客户端拒绝降级。 */
export const ServerHello = s.object({ hs: s.string({ min: 1 }), v: s.optional(s.union(s.literal(1), s.literal(2))) })
export type ServerHelloT = Infer<typeof ServerHello>

/**
 * 明文控制错误:后台的 `auth_failed`(令牌不认,致命)、`upgrade_required`(握手说的是退休了的 v1,
 * 致命)、`stream_unknown`(后台不认这条流 —— 多半是它跟中继重连过、把流状态丢了,客户端该断开重握手),
 * 中继的 `daemon_offline` 等。
 */
export const ErrorFrame = s.object({ error: s.string({ min: 1 }) })

export const SealedV2Frame = s.object({ c: s.string(), ct: s.string() })

// ── v2 密封帧内部 ────────────────────────────────────────────────────────

const Headers = s.record(s.string())
const BodyEncoding = s.oneOf(['utf8', 'base64'])
const Since = s.object({ epoch: s.string(), seq: s.int({ min: 0 }) })
const id = () => s.string({ min: 1 })

export const ReqMsg = s.object({
  t: s.literal('req'),
  rid: id(),
  method: id(),
  path: s.string(),
  headers: s.optional(Headers),
  body: s.optional(s.string()),
  bodyEncoding: s.optional(BodyEncoding),
})
export const ResMsg = s.object({
  t: s.literal('res'),
  rid: id(),
  status: s.int(),
  headers: Headers,
  body: s.string(),
  bodyEncoding: BodyEncoding,
})
export const SubMsg = s.object({ t: s.literal('sub'), sid: id(), topic: id(), since: s.optional(Since) })
export const UnsubMsg = s.object({ t: s.literal('unsub'), sid: id() })
export const EvMsg = s.object({
  t: s.literal('ev'),
  sid: id(),
  epoch: s.string(),
  seq: s.int({ min: 0 }),
  data: s.unknown(),
})
export const ErrMsg = s.object({ t: s.literal('err'), rid: s.optional(s.string()), sid: s.optional(s.string()), code: id() })
/** 保活:客户端只挂着订阅、很久没收到东西时发;后台原样带 rid 回 `pong`。不进面板路由。 */
export const PingMsg = s.object({ t: s.literal('ping'), rid: id() })
export const PongMsg = s.object({ t: s.literal('pong'), rid: id() })

export const V2Message = s.discriminatedUnion('t', [ReqMsg, ResMsg, SubMsg, UnsubMsg, EvMsg, ErrMsg, PingMsg, PongMsg])
/** 客户端 → 后台。 */
export const V2ClientMessage = s.discriminatedUnion('t', [ReqMsg, SubMsg, UnsubMsg, PingMsg])
/** 后台 → 客户端。 */
export const V2ServerMessage = s.discriminatedUnion('t', [ResMsg, EvMsg, ErrMsg, PongMsg])

export type ReqMsgT = Infer<typeof ReqMsg>
export type ResMsgT = Infer<typeof ResMsg>
export type SubMsgT = Infer<typeof SubMsg>
export type UnsubMsgT = Infer<typeof UnsubMsg>
export type EvMsgT = Infer<typeof EvMsg>
export type ErrMsgT = Infer<typeof ErrMsg>
export type PingMsgT = Infer<typeof PingMsg>
export type PongMsgT = Infer<typeof PongMsg>
export type V2MessageT = Infer<typeof V2Message>
export type V2ClientMessageT = Infer<typeof V2ClientMessage>
export type V2ServerMessageT = Infer<typeof V2ServerMessage>

// ── 标准 base64(bodyEncoding: 'base64')────────────────────────────────
// 借 b64u 的纯运算实现换字母表,不碰 atob/btoa(RN/Hermes 未必有)。

/** 标准 base64(RFC 4648 §4,`+/`,带 `=` 填充)。 */
export function b64Encode(bytes: Uint8Array): string {
  const s = b64uEncode(bytes).replace(/-/g, '+').replace(/_/g, '/')
  return s + '='.repeat((4 - (s.length % 4)) % 4)
}

/** 严格:只收标准字母表;含 `-`/`_` 或非法字符 ⇒ 抛。 */
export function b64Decode(s: string): Uint8Array {
  if (/[-_]/.test(s)) throw new Error('b64Decode: base64url characters in standard base64')
  return b64uDecode(s.replace(/\+/g, '-').replace(/\//g, '_'))
}
