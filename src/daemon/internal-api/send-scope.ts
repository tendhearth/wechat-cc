/**
 * 发送类路由的 chat 范围门(2026-10-03)。
 *
 * 问题:reply / reply_voice / send_file / edit_message / broadcast / 表情包 /
 * share_page / set-mode 都从请求体拿 chat_id,以前从不和调用方自己的 chat 比。
 * 结果任何会话 —— 包括 guest 会话 —— 都能以 CC 的身份给任意 chat 发消息
 * (一段被提示注入的访客对话就能去骚扰主人或别的访客),也能把字塞进别的
 * chat 正开着的 App 回复截流口(reply sink)。
 *
 * 规则(窄修;回复投递的大改另行设计,这里不抢跑):
 *   - 只管 session 来源的令牌(每个 agent 会话一枚,sessionKey =
 *     `provider/alias/chatId`)。file / operator / device / link 令牌照旧 ——
 *     它们是 daemon 内部、CLI 与桌面宿主,不是某一个 chat 的会话。
 *   - 指名一个 chat 的路由:**任何档**(guest / trusted / admin)都只能发给
 *     自己会话的 chat。主人会话发往别的 chat,现有功能里没有一处靠它:提醒本来
 *     就按本 chat 限(routes-reminders.ts),社交 / A2A / 串门 / 主动关怀走自己的
 *     路由或 daemon 内部直接调 ilink,App 通道的 sink 开在主人自己的 chat 上。
 *   - broadcast(发给所有人,天然跨 chat):只有 admin 会话可以;非 admin ⇒ 拒。
 *   - session 令牌读不出 chat(sessionKey 不是三段)⇒ 拒(fail closed),
 *     唯一例外是 `agy-static`,见下。
 *   - `agy-static`:agy 只有一份全局 MCP 配置,所有 agy 对话共用这一枚 trusted
 *     令牌,它没有「自己的 chat」。照旧放行 —— 它与 trusted 的 file 令牌同级
 *     (同样落盘、同样跨对话),补偿控制仍是 `/agy` 拒 guest。已知缺口,写在
 *     docs/reference/internal-api-auth.md。
 *
 * 拒绝:403 `{ error: 'chat_scope', message }`,message 明说什么都没发出去;
 * 不回显被请求的 chat_id(同 reminder_scope_denied 的做法),目标只进本地日志。
 *
 * 门放在 dispatcher(index.ts),在 schema 校验之后、handler 之前 —— 在 sink
 * 截流、旁听、分片、ilink 之前,所以被拒的请求一个字都碰不到微信或 App。
 */
import type { UserTier } from '../../core/user-tier'
import type { TokenOrigin } from './token-registry'
import { AGY_STATIC_SESSION_KEY } from './token-registry'

/** 发给所有人(broadcast)。 */
export const ALL_CHATS = Symbol('all_chats')
export type SendTarget = string | typeof ALL_CHATS | null

function bodyField(body: unknown, key: string): unknown {
  return body && typeof body === 'object' ? (body as Record<string, unknown>)[key] : undefined
}

/**
 * 每条「往某个 chat 发 / 改消息」的路由 → 从请求体取出目标。
 * 返回 null = 这次请求没指名 chat(例如 share_page 不带 chat_id),不设门;
 * 非字符串的 chat_id 也返回 null,让 handler 自己回 400。
 */
const byChatId = (key: string) => (body: unknown): SendTarget => {
  const v = bodyField(body, key)
  return typeof v === 'string' ? v : null
}

export const SEND_SCOPED_ROUTES: Readonly<Record<string, (body: unknown) => SendTarget>> = {
  'POST /v1/wechat/reply': byChatId('chat_id'),
  'POST /v1/wechat/reply_voice': byChatId('chat_id'),
  'POST /v1/wechat/send_file': byChatId('chat_id'),
  'POST /v1/wechat/edit_message': byChatId('chat_id'),
  'POST /v1/wechat/send_sticker': byChatId('chat_id'),
  'POST /v1/wechat/search_online_sticker': byChatId('chat_id'),
  'POST /v1/wechat/send_online_sticker_candidate': byChatId('chat_id'),
  // 不发消息,但改的是那个 chat 的表情偏好 —— 同样只许改自己的。
  'POST /v1/wechat/sticker_feedback': byChatId('chat_id'),
  // chat_id 决定页脚「发 PDF 到微信」推给谁。
  'POST /v1/share/page': byChatId('chat_id'),
  // 切那个 chat 的模式,并(非 quiet 时)往那个 chat 发一句「已切换」。
  'POST /v1/conversation/set-mode': byChatId('chatId'),
  'POST /v1/wechat/broadcast': () => ALL_CHATS,
}

export interface SendScopeCaller {
  tier: UserTier
  origin: TokenOrigin
  chatId?: string | undefined
  sessionKey?: string | undefined
}

export const CHAT_SCOPE_MESSAGE =
  'chat_scope: this conversation may only send to its own chat_id; nothing was sent'
export const BROADCAST_SCOPE_MESSAGE =
  'chat_scope: broadcast is owner-only for agent sessions; nothing was sent'

/** null = 放行;否则是给调用方的拒绝说明。 */
export function sendScopeDenial(target: SendTarget, caller: SendScopeCaller): string | null {
  if (target === null) return null
  if (caller.origin !== 'session') return null
  if (caller.sessionKey === AGY_STATIC_SESSION_KEY) return null
  if (target === ALL_CHATS) return caller.tier === 'admin' ? null : BROADCAST_SCOPE_MESSAGE
  if (!caller.chatId) return CHAT_SCOPE_MESSAGE
  return caller.chatId === target ? null : CHAT_SCOPE_MESSAGE
}
