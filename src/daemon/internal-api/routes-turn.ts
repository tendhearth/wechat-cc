/**
 * 回复交付(spec docs/superpowers/specs/2026-10-03-reply-delivery-design.md §4.5 / §4.6)的两条路由。
 * 只有 `replyDelivery = daemon` 的 provider 用得到(它们的 wechat MCP 不再注册 reply 族工具)。
 *
 * POST /v1/turn/attach —— 语音 / 表情 / 文件是**这一轮回复的附件**:工具调用时只登记,daemon 在交付时
 *   (文字之后、按调用顺序)才真的发。**不收 chat_id**:目标永远是会话令牌里的那个 chat —— 顺带关掉
 *   「任意 chat_id」的口子。表情 / 文件的真正发送原样复用老路由(冷却、GIPHY 白名单、偏好记账不变)。
 *   回执是 `{ok:true, attached:true}`,不是 msg_id(还没发)。
 *
 * POST /v1/wechat/message —— admin 往**别处**发(别的聊天 / 主人自己的微信 / 群发)。`to` 等于本轮
 *   聊天 ⇒ 报错:不给模型留一条「在本轮里用工具说话」的旧路,否则连发会换个工具名回来。发给主人
 *   聊天的话记一笔,交付时去重(REPLY_DEDUPED)。
 */
import { existsSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { PendingAttachment } from '../reply-delivery'
import type { StickerRef, TurnAttachment } from '../../core/turn-reply'
import { errMsg, type InternalApiDeps, type RouteTable } from './types'
import { tierMeets } from './route-tiers'

const VOICE_LIMIT = 500

const NO_TURN = 'no_turn_in_progress: nothing was attached — attachments only ride on the reply of a turn that is in progress in this chat'
const OWN_CHAT = 'message_to_own_chat: nothing was sent — what you want to say in THIS chat goes in your final text; the daemon delivers it. `message` is only for other targets.'

const str = (v: unknown): string | undefined => typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined

/** 老路由的回执 → 附件发送结果。 */
function okOf(r: { status: number; body: unknown }): { ok: boolean; error?: string } {
  const b = (r.body ?? {}) as { ok?: unknown; error?: unknown; reason?: unknown }
  if (r.status === 200 && b.ok === true) return { ok: true }
  return { ok: false, error: String(b.error ?? b.reason ?? `status_${r.status}`) }
}

export function turnRoutes(deps: InternalApiDeps, table: () => RouteTable): RouteTable {
  const viaRoute = (key: string, body: Record<string, unknown>) => async (): Promise<{ ok: boolean; error?: string }> => {
    const h = table()[key]
    if (!h) return { ok: false, error: `${key} not wired` }
    try { return okOf(await h(new URLSearchParams(), body, undefined)) } catch (err) { return { ok: false, error: errMsg(err) } }
  }

  return {
    'POST /v1/turn/attach': async (_q, body, caller) => {
      const rd = deps.replyDelivery
      if (!rd) return { status: 503, body: { error: 'reply_delivery_not_wired' } }
      const chatId = caller?.origin === 'session' ? caller.chatId : undefined
      if (!chatId) return { status: 400, body: { ok: false, error: 'no_turn_chat: only an agent session can attach to its own turn' } }
      const b = (body ?? {}) as Record<string, unknown>

      let attachment: TurnAttachment
      let send: PendingAttachment['send']
      if (b.kind === 'voice') {
        const text = str(b.text)
        if (!text) return { status: 400, body: { ok: false, error: 'text required (non-empty string)' } }
        if (text.length > VOICE_LIMIT) return { status: 200, body: { ok: false, reason: 'too_long', limit: VOICE_LIMIT } }
        if (!deps.voice) return { status: 503, body: { error: 'voice_not_wired' } }
        const voice = deps.voice
        attachment = { kind: 'voice', text }
        send = async () => {
          const r = await voice.replyVoice(chatId, text)
          return r.ok ? { ok: true } : { ok: false, error: r.reason }
        }
      } else if (b.kind === 'sticker') {
        const tag = str(b.tag), mood = str(b.mood), url = str(b.url), query = str(b.query), id = str(b.id)
        let ref: StickerRef
        if (tag) {
          if (!deps.stickers) return { status: 503, body: { error: 'stickers_not_wired' } }
          if (deps.stickers.resolve(tag, chatId) === null) {
            return { status: 200, body: { ok: false, reason: 'no_sticker_for_tag', tags: deps.stickers.allTags() } }
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
