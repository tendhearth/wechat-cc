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
 *   - 指名一个 chat 的路由:guest / trusted 会话只能发给自己会话的 chat。
 *   - admin(主人自己的)会话发往别的 chat **暂时放行**,但记一条
 *     `chat_scope_admin_cross` 日志统计用量。原因:主人会直接让 CC「帮我告诉
 *     某个访客……」,这是模型发起的 reply 到别的 chat,代码里没有对应调用点,
 *     一拦就断。收紧时间点:回复交付重构做出 admin 专用的 `message` 工具之后,
 *     reply 收紧到只能发本 chat(回复交付 spec §5)。
 *   - broadcast(发给所有人,天然跨 chat):只有 admin 会话可以;非 admin ⇒ 拒。
 *   - 非 admin 的 session 令牌读不出 chat(sessionKey 不是三段)⇒ 拒(fail closed),
 *     唯一例外是 `agy-static`,见下。
 *   - `agy-static`:agy 只有一份全局 MCP 配置,所有 agy 对话共用这一枚 trusted
 *     令牌,它没有「自己的 chat」。
 *       · agy 走 legacy / shadow(用 reply 工具说话):照旧放行 —— 它与 trusted 的 file
 *         令牌同级(同样落盘、同样跨对话),补偿控制仍是 `/agy` 拒 guest。
 *       · agy 走 daemon 交付(回复交付第 2 步,2026-10-03):它不再需要按 chat_id 发任何
 *         东西(回复由 daemon 送达,附件绑在本轮上)⇒ 豁免取消。它的「自己的 chat」就是
 *         此刻正在跑的那一轮 agy 的聊天(`ReplyDeliveryRuntime.turnChatFor('agy')`);
 *         没有轮在跑 / 同时有两轮 ⇒ 读不出 ⇒ 按 trusted 规则拒(fail closed)。
 *     见 docs/reference/internal-api-auth.md。
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
  // 回复交付 §4.6 的 message:to=broadcast ⇒ 所有人;to=owner ⇒ 由路由解析成主人聊天(只有 admin 能调,不设门);
  // 其余就是那个 chat_id。路由本身是 admin 级,这里的作用是把跨 chat 记进 chat_scope_admin_cross。
  'POST /v1/wechat/message': (body: unknown): SendTarget => {
    const to = bodyField(body, 'to')
    if (to === 'broadcast') return ALL_CHATS
    if (to === 'owner' || typeof to !== 'string') return null
    return to
  },
}

export interface SendScopeCaller {
  tier: UserTier
  origin: TokenOrigin
  chatId?: string | undefined
  sessionKey?: string | undefined
  /** 共享令牌已按本轮绑定(agy daemon 模式):不再豁免,`chatId` 是绑定到的那一轮的聊天(可能读不出)。 */
  sharedTokenBound?: boolean
}

export const CHAT_SCOPE_MESSAGE =
  'chat_scope: this conversation may only send to its own chat_id; nothing was sent'
export const BROADCAST_SCOPE_MESSAGE =
  'chat_scope: broadcast is owner-only for agent sessions; nothing was sent'

export type SendScopeDecision =
  | { kind: 'allow' }
  /** admin 会话发往别的 chat:暂时放行,调用方要记 `chat_scope_admin_cross`。 */
  | { kind: 'admin_cross' }
  | { kind: 'deny'; message: string }

const ALLOW: SendScopeDecision = { kind: 'allow' }

export function sendScopeDecision(target: SendTarget, caller: SendScopeCaller): SendScopeDecision {
  if (target === null) return ALLOW
  if (caller.origin !== 'session') return ALLOW
  if (caller.sessionKey === AGY_STATIC_SESSION_KEY && caller.sharedTokenBound !== true) return ALLOW
  if (target === ALL_CHATS) return caller.tier === 'admin' ? ALLOW : { kind: 'deny', message: BROADCAST_SCOPE_MESSAGE }
  if (caller.chatId && caller.chatId === target) return ALLOW
  // 暂时放行(见模块注释):等 admin 专用 `message` 工具落地再收紧。
  if (caller.tier === 'admin') return { kind: 'admin_cross' }
  return { kind: 'deny', message: CHAT_SCOPE_MESSAGE }
}

/**
 * 共享令牌按「本轮」绑定(回复交付第 2 步)。只对 `agy-static` 且 agy 走 daemon 交付时生效;否则 undefined
 * (调用方照旧)。纯函数:模式与运行时的查询由 dispatcher 注入。
 */
export function sharedTokenTurn(
  caller: { origin: TokenOrigin; sessionKey?: string | undefined },
  opts: { agyDaemon: boolean; turnChatFor?: ((providerId: string) => { kind: 'bound'; chatId: string } | { kind: 'none' } | { kind: 'ambiguous'; count: number }) | undefined },
): { kind: 'bound'; chatId: string } | { kind: 'none' } | { kind: 'ambiguous' } | undefined {
  if (caller.origin !== 'session' || caller.sessionKey !== AGY_STATIC_SESSION_KEY || !opts.agyDaemon) return undefined
  const b = opts.turnChatFor?.('agy') ?? { kind: 'none' as const }
  return b.kind === 'bound' ? b : b.kind === 'ambiguous' ? { kind: 'ambiguous' } : { kind: 'none' }
}
