/**
 * 回复交付(spec docs/superpowers/specs/2026-10-03-reply-delivery-design.md §4.5 / §4.6)的两条路由。
 * 执行者的 wechat MCP 没有 reply 族工具(回复是最后写下的文字),附件和往别处发就走这两条。
 *
 * POST /v1/turn/attach —— 语音 / 表情 / 文件是**这一轮回复的附件**:工具调用时只登记,daemon 在交付时
 *   (文字之后、按调用顺序)才真的发。**不收 chat_id**:目标永远是会话令牌里的那个 chat —— 顺带关掉
 *   「任意 chat_id」的口子。共享令牌(agy 的 `agy-static`,令牌里没有 chat)绑到 agy 此刻正在跑的那一轮
 *   (dispatcher 的 `turnChatId`);同时有两轮 agy 在跑 ⇒ 说不清是哪一轮 ⇒ 拒,不猜。表情 / 文件的真正发送原样复用老路由(冷却、GIPHY 白名单、偏好记账不变)。
 *   回执是 `{ok:true, attached:true}`,不是 msg_id(还没发)。
 *
 * POST /v1/wechat/message —— admin 往**别处**发(别的聊天 / 主人自己的微信 / 群发)。`to` 等于本轮
 *   聊天 ⇒ 报错:不给模型留一条「在本轮里用工具说话」的旧路,否则连发会换个工具名回来。发给主人
 *   聊天的话记一笔,交付时去重(REPLY_DEDUPED)。
 */
import { existsSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { PendingAttachment } from '../reply-delivery'
import type { StickerRef, TurnAttachment } from '../../domain/turn-reply'
import { errMsg, type InternalApiDeps, type RouteHandler, type RouteTable } from './types'
import { countForTag } from '../../domain/sticker-tag'
import { tierMeets } from './route-tiers'

const VOICE_LIMIT = 500

const NO_TURN = 'no_turn_in_progress: nothing was attached — attachments only ride on the reply of a turn that is in progress in this chat'
const AMBIGUOUS = 'ambiguous_turn: nothing was attached — this shared session token is answering more than one conversation right now, so it cannot tell which reply to attach to. Say it in words instead.'
const OWN_CHAT = 'message_to_own_chat: nothing was sent — what you want to say in THIS chat goes in your final text; the daemon delivers it. `message` is only for other targets.'

const str = (v: unknown): string | undefined => typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined

/** 老路由的回执 → 附件发送结果。 */
function okOf(r: { status: number; body: unknown }): { ok: boolean; error?: string } {
  const b = (r.body ?? {}) as { ok?: unknown; error?: unknown; reason?: unknown }
  if (r.status === 200 && b.ok === true) return { ok: true }
  return { ok: false, error: String(b.error ?? b.reason ?? `status_${r.status}`) }
}

/**
 * `route(key)`:按路由键找处理器 —— internal-api 自己那张表,加上功能模块挂上来的(表情那几条归 stickers 模块,
 * src/features/stickers;语音的 reply_voice 归 voice 模块,src/features/voice)。交付时才找,所以模块晚于 internal-api 挂上也接得住。
 */
export function turnRoutes(deps: InternalApiDeps, route: (key: string) => RouteHandler | undefined): RouteTable {
  const viaRoute = (key: string, body: Record<string, unknown>) => async (): Promise<{ ok: boolean; error?: string }> => {
    const h = route(key)
    if (!h) return { ok: false, error: `${key} not wired` }
    try { return okOf(await h(new URLSearchParams(), body, undefined)) } catch (err) { return { ok: false, error: errMsg(err) } }
  }

  return {
    'POST /v1/turn/attach': async (_q, body, caller) => {
      const rd = deps.replyDelivery
      if (!rd) return { status: 503, body: { error: 'reply_delivery_not_wired' } }
      // 会话令牌里的 chat;共享令牌(agy-static)用 dispatcher 按本轮绑定出来的那个(回复交付第 2 步)。
      if (caller?.sharedTurn === 'ambiguous') return { status: 200, body: { ok: false, error: AMBIGUOUS } }
      const chatId = caller?.origin === 'session' ? (caller.chatId || caller.turnChatId) : undefined
      if (!chatId && caller?.sharedTurn === 'none') return { status: 200, body: { ok: false, error: NO_TURN } }
      if (!chatId) return { status: 400, body: { ok: false, error: 'no_turn_chat: only an agent session can attach to its own turn' } }
      const b = (body ?? {}) as Record<string, unknown>

      let attachment: TurnAttachment
      let send: PendingAttachment['send']
      if (b.kind === 'voice') {
        const text = str(b.text)
        if (!text) return { status: 400, body: { ok: false, error: 'text required (non-empty string)' } }
        if (text.length > VOICE_LIMIT) return { status: 200, body: { ok: false, reason: 'too_long', limit: VOICE_LIMIT } }
        // 语音归语音功能(src/features/voice,模块自己挂 reply_voice):和表情一样,交付时经路由表复用那条老路由。
        // 模块关着 / 坏了 / 还没挂上 ⇒ 表里没有这条 ⇒ 跟以前「没接语音」一样当场 503,不登记。
        if (!route('POST /v1/wechat/reply_voice')) return { status: 503, body: { error: 'voice_not_wired' } }
        attachment = { kind: 'voice', text }
        send = viaRoute('POST /v1/wechat/reply_voice', { chat_id: chatId, text })
      } else if (b.kind === 'sticker') {
        const tag = str(b.tag), mood = str(b.mood), url = str(b.url), query = str(b.query), id = str(b.id)
        let ref: StickerRef
        if (tag) {
          // 表情库归 stickers 模块:先经它挂上的 GET /v1/stickers 看库里有没有这个 tag(countForTag 与 resolve 同一种比法:
          // trim + 不分大小写)。模块没挂上 ⇒ 跟以前没接表情库一样回 503 stickers_not_wired。
          const lib = route('GET /v1/stickers')
          if (!lib) return { status: 503, body: { error: 'stickers_not_wired' } }
          const listed = ((await lib(new URLSearchParams(), undefined, undefined)).body ?? {}) as { stickers?: Array<{ tags: string[] }>; tags?: string[] }
          if (countForTag(listed.stickers ?? [], tag) === 0) {
            return { status: 200, body: { ok: false, reason: 'no_sticker_for_tag', tags: listed.tags ?? [] } }
          }
          ref = { tag }
          send = viaRoute('POST /v1/wechat/send_sticker', { chat_id: chatId, tag })
        } else if (mood && url) {
          ref = { mood, url, ...(id ? { id } : {}) }
          send = viaRoute('POST /v1/wechat/send_online_sticker_candidate', { chat_id: chatId, mood, ...(id ? { id } : {}), url })
        } else if (mood && query) {
          ref = { mood, query }
          send = viaRoute('POST /v1/wechat/search_online_sticker', { chat_id: chatId, mood, query })
        } else {
          return { status: 400, body: { ok: false, error: 'sticker needs tag, or mood+url (a candidate you picked), or mood+query' } }
        }
        attachment = { kind: 'sticker', ref }
      } else if (b.kind === 'file') {
        // 和 send_file 的 trusted 门同级(route-tiers):guest 不能把电脑上的文件发出去。
        if (!tierMeets(caller!.tier, 'trusted')) return { status: 200, body: { ok: false, error: 'forbidden' } }
        const path = str(b.path)
        if (!path || !isAbsolute(path)) return { status: 200, body: { ok: false, error: 'path must be an absolute path' } }
        if (!existsSync(path) || !statSync(path).isFile()) return { status: 200, body: { ok: false, error: 'no_such_file' } }
        if (!deps.ilink) return { status: 503, body: { error: 'ilink_not_wired' } }
        const ilink = deps.ilink
        attachment = { kind: 'file', path }
        send = async () => { try { await ilink.sendFile(chatId, path); return { ok: true } } catch (err) { return { ok: false, error: errMsg(err) } } }
      } else {
        return { status: 400, body: { ok: false, error: "kind must be 'voice' | 'sticker' | 'file'" } }
      }

      if (!rd.attach(chatId, { attachment, send })) return { status: 200, body: { ok: false, error: NO_TURN } }
      return { status: 200, body: { ok: true, attached: true } }
    },

    'POST /v1/wechat/message': async (_q, body, caller) => {
      if (!deps.ilink) return { status: 503, body: { error: 'ilink_not_wired' } }
      const b = (body ?? {}) as { to?: unknown; text?: unknown; account_id?: unknown }
      const to = str(b.to)
      if (!to) return { status: 400, body: { ok: false, error: "to required: 'owner' | <chat_id> | 'broadcast'" } }
      const text = typeof b.text === 'string' ? b.text : ''
      if (!text.trim()) return { status: 200, body: { ok: false, error: 'empty_text: nothing was sent' } }
      const callerChat = caller?.origin === 'session' ? caller.chatId : undefined
      if (to === 'broadcast') {
        try { return { status: 200, body: await deps.ilink.broadcast(text, str(b.account_id)) } } catch (err) { return { status: 200, body: { ok: false, error: errMsg(err) } } }
      }
      const ownerChat = deps.resolveAdminChatId?.() ?? null
      const target = to === 'owner' ? ownerChat : to
      if (!target) return { status: 200, body: { ok: false, error: 'owner_not_configured: nothing was sent' } }
      if (callerChat && target === callerChat) return { status: 200, body: { ok: false, error: OWN_CHAT } }
      try {
        const r = await deps.ilink.sendReply(target, text)
        if (r.error) return { status: 200, body: { ok: false, error: r.error } }
        if (callerChat) deps.replyDelivery?.noteMessage(callerChat, { toOwner: target === ownerChat, text })
        return { status: 200, body: { ok: true, msg_id: r.msgId } }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },
  }
}
