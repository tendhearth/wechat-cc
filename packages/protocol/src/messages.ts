/**
 * messages.ts — 手机隧道线上消息的形状(zod)。线上来的一切都不可信:收方
 * 先 `safeParse`,不合形状就丢(记一笔协议错误),永远不往外抛。
 *
 * 分两层:
 *   1. 明文帧(握手、控制错误)与密封帧外壳 —— 这些直接走 WebSocket。
 *   2. 密封帧里面的 v2 消息 —— 以 `t` 区分的判别联合。
 *
 * v1 的请求/响应(`{path, method, body?, rid}` / `{rid, status, body}`)也
 * 在这里定形状,客户端对着老后台时用。
 *
 * zod v4:用默认导出 `import z from 'zod'`(具名 `{ z }` 在 vitest 打包下会
 * 解析成 undefined,见 src/cli/schema.ts 的注释)。
 */
import z from 'zod'
import { b64uEncode, b64uDecode } from './b64u'

// ── 明文帧 ───────────────────────────────────────────────────────────────

/** 客户端握手:裸 X25519 公钥(base64url)+ 支持的版本列表。 */
export const ClientHello = z.object({ hs: z.string(), v: z.array(z.number().int()).optional() })
export type ClientHelloT = z.infer<typeof ClientHello>

/** 后台握手回应:不带 `v` ⇒ 老后台,只会 v1。 */
export const ServerHello = z.object({ hs: z.string().min(1), v: z.union([z.literal(1), z.literal(2)]).optional() })
export type ServerHelloT = z.infer<typeof ServerHello>

/** 明文控制错误:后台的 `auth_failed`,中继的 `daemon_offline` 等。 */
export const ErrorFrame = z.object({ error: z.string().min(1) })

export const SealedV1Frame = z.object({ iv: z.string(), ct: z.string() })
export const SealedV2Frame = z.object({ c: z.string(), ct: z.string() })

// ── v1 密封帧内部 ────────────────────────────────────────────────────────

export const V1Request = z.object({
  path: z.string(),
  method: z.string(),
  body: z.string().optional(),
  rid: z.string(),
})
export type V1RequestT = z.infer<typeof V1Request>

export const V1Response = z.object({ rid: z.string(), status: z.number().int(), body: z.string() })
export type V1ResponseT = z.infer<typeof V1Response>

// ── v2 密封帧内部 ────────────────────────────────────────────────────────

const Headers = z.record(z.string(), z.string())
const BodyEncoding = z.enum(['utf8', 'base64'])
const Since = z.object({ epoch: z.string(), seq: z.number().int().nonnegative() })

export const ReqMsg = z.object({
  t: z.literal('req'),
  rid: z.string().min(1),
  method: z.string().min(1),
  path: z.string(),
  headers: Headers.optional(),
  body: z.string().optional(),
  bodyEncoding: BodyEncoding.optional(),
})
export const ResMsg = z.object({
  t: z.literal('res'),
  rid: z.string().min(1),
  status: z.number().int(),
  headers: Headers,
  body: z.string(),
  bodyEncoding: BodyEncoding,
})
export const SubMsg = z.object({ t: z.literal('sub'), sid: z.string().min(1), topic: z.string().min(1), since: Since.optional() })
export const UnsubMsg = z.object({ t: z.literal('unsub'), sid: z.string().min(1) })
export const EvMsg = z.object({
  t: z.literal('ev'),
  sid: z.string().min(1),
  epoch: z.string(),
  seq: z.number().int().nonnegative(),
  data: z.unknown(),
})
export const ErrMsg = z.object({ t: z.literal('err'), rid: z.string().optional(), sid: z.string().optional(), code: z.string().min(1) })

export const V2Message = z.discriminatedUnion('t', [ReqMsg, ResMsg, SubMsg, UnsubMsg, EvMsg, ErrMsg])
/** 客户端 → 后台。 */
export const V2ClientMessage = z.discriminatedUnion('t', [ReqMsg, SubMsg, UnsubMsg])
/** 后台 → 客户端。 */
export const V2ServerMessage = z.discriminatedUnion('t', [ResMsg, EvMsg, ErrMsg])

export type ReqMsgT = z.infer<typeof ReqMsg>
export type ResMsgT = z.infer<typeof ResMsg>
export type SubMsgT = z.infer<typeof SubMsg>
export type UnsubMsgT = z.infer<typeof UnsubMsg>
export type EvMsgT = z.infer<typeof EvMsg>
export type ErrMsgT = z.infer<typeof ErrMsg>
export type V2MessageT = z.infer<typeof V2Message>
export type V2ClientMessageT = z.infer<typeof V2ClientMessage>
export type V2ServerMessageT = z.infer<typeof V2ServerMessage>

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
