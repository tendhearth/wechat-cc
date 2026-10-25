/**
 * 贴纸的路由(image-stickers plan + online-sticker-search)—— 由 stickers 模块自己挂上(internalApi.mount),
 * 路由表标了 `module: 'stickers'`。从 internal-api/routes.ts 原样搬出(架构终态 A5),回执一个字不改。
 *
 *   POST /v1/wechat/send_sticker                      —— 表情库里按 tag 挑一张发(send_sticker MCP 工具)
 *   POST /v1/wechat/search_online_sticker             —— 本地这个心情不够 K 张 ⇒ 联网找一张、发、存进库
 *   POST /v1/wechat/search_online_sticker_candidates  —— 只列联网候选,让 CC 自己挑
 *   POST /v1/wechat/send_online_sticker_candidate     —— 发 CC 挑中的那张(只认 GIPHY 的地址)
 *   POST /v1/wechat/sticker_feedback                  —— 主人对上一张表情的反应(影响以后挑哪张)
 *   POST /v1/stickers / GET /v1/stickers              —— 存一张进库 / 列库
 *
 * 这几条都是**手写校验**(没有 REQUEST_SCHEMAS 那一条),跟 /v1/chat-prefs 一样。
 * 「表情库没接上」那几种 503 不用再写:模块没起来时路由层回 module_off / module_degraded / module_starting。
 * `/v1/turn/attach` 的表情附件仍在 internal-api(回复交付是通用的那条路),交付时经路由表调到这里的处理器。
 */
import { basename, join } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { errMsg, type RouteTable } from '../../daemon/internal-api/types'
import { countForTag, ONLINE_STICKER_K, type StickerLib } from './stickers'
import { makeCooldown, type StickerSource } from './source'
import type { StickerFeedback } from './feedback'

export interface StickersRoutesDeps {
  stickers: StickerLib
  /** 联网表情源;没有 ⇒ 联网那三条回 503 sticker_source_not_wired(功能安全地关着)。 */
  stickerSource?: StickerSource
  stickerFeedback?: Pick<StickerFeedback, 'remember' | 'rate'>
  /** 发到微信(和 send_file 同一个口),发完把联网存下的那张记进 App 对话。 */
  ilink: {
    sendFile(chatId: string, path: string): Promise<void>
    noteSentMedia?(chatId: string, m: { kind: 'sticker'; file: string; label: string }): void
  }
}

export function stickersRoutes(deps: StickersRoutesDeps): RouteTable {
  const onlineStickerCooldown = makeCooldown(5 * 60_000)
  // Rotate through upstream candidates per chat so repeated requests do not
  // always pick the first (often identical) GIPHY result.
  const onlineStickerCursor = new Map<string, number>()
  return {
    'POST /v1/wechat/send_sticker': async (_q, body) => {
      const b = (body ?? {}) as { chat_id?: unknown; tag?: unknown }
      if (typeof b.chat_id !== 'string' || b.chat_id.trim() === '') {
        return { status: 400, body: { error: 'chat_id required (non-empty string)' } }
      }
      if (typeof b.tag !== 'string' || b.tag.trim() === '') {
        return { status: 400, body: { error: 'tag required (non-empty string)' } }
      }
      const path = deps.stickers.resolve(b.tag, b.chat_id)
      if (path === null) {
        return { status: 200, body: { ok: false, reason: 'no_sticker_for_tag', tags: deps.stickers.allTags() } }
      }
      try {
        await deps.ilink.sendFile(b.chat_id, path)
        deps.stickerFeedback?.remember(b.chat_id, basename(path))
        return { status: 200, body: { ok: true, file: basename(path) } }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },
    'POST /v1/wechat/search_online_sticker': async (_q, body) => {
      if (!deps.stickerSource) return { status: 503, body: { error: 'sticker_source_not_wired' } }
      const b = (body ?? {}) as { chat_id?: unknown; mood?: unknown; query?: unknown }
      if (typeof b.chat_id !== 'string' || !b.chat_id.trim()) return { status: 400, body: { error: 'chat_id required (non-empty string)' } }
      if (typeof b.mood !== 'string' || !b.mood.trim()) return { status: 400, body: { error: 'mood required (non-empty string)' } }
      if (typeof b.query !== 'string' || !b.query.trim()) return { status: 400, body: { error: 'query required (non-empty string)' } }
      const chatId = b.chat_id.trim(), mood = b.mood.trim(), query = b.query.trim()
      if (countForTag(deps.stickers.list(), mood) >= ONLINE_STICKER_K) {
        const local = deps.stickers.resolve(mood)
        if (local) try {
          await deps.ilink.sendFile(chatId, local)
          return { status: 200, body: { ok: true, source: 'local', file: basename(local) } }
        } catch (err) { return { status: 200, body: { ok: false, error: errMsg(err) } } }
      }
      if (!onlineStickerCooldown.ready(chatId, Date.now())) return { status: 200, body: { ok: false, reason: 'throttled' } }
      let scratch: string | undefined
      let onlineSent = false
      try {
        const hits = await deps.stickerSource.search(query, { limit: 8 })
        if (hits.length === 0) return { status: 200, body: { ok: false, reason: 'no_online_result' } }
        const cursor = onlineStickerCursor.get(chatId) ?? 0
        const hit = hits[cursor % hits.length]!
        onlineStickerCursor.set(chatId, cursor + 1)
        const download = await deps.stickerSource.download(hit.url)
        if (!download) return { status: 200, body: { ok: false, reason: 'no_online_result' } }
        scratch = mkdtempSync(join(tmpdir(), 'online-sticker-'))
        const path = join(scratch, `${hit.id}.${download.ext}`)
        writeFileSync(path, download.bytes)
        await deps.ilink.sendFile(chatId, path)
        onlineSent = true
        const saved = deps.stickers.save(path, [mood], `CC 联网找的「${mood}」表情`)
        deps.stickerFeedback?.remember(chatId, saved.file)
        deps.ilink.noteSentMedia?.(chatId, { kind: 'sticker', file: saved.file, label: mood })
        return { status: 200, body: { ok: true, source: 'online', file: saved.file } }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      } finally {
        if (!onlineSent) onlineStickerCooldown.reset(chatId)
        if (scratch) rmSync(scratch, { recursive: true, force: true })
      }
    },
    'POST /v1/wechat/search_online_sticker_candidates': async (_q, body) => {
      if (!deps.stickerSource) return { status: 503, body: { error: 'sticker_source_not_wired' } }
      const b = (body ?? {}) as { query?: unknown }
      if (typeof b.query !== 'string' || !b.query.trim()) return { status: 400, body: { error: 'query required (non-empty string)' } }
      const hits = await deps.stickerSource.search(b.query.trim(), { limit: 8 })
      return { status: 200, body: { ok: true, candidates: hits.slice(0, 8) } }
    },
    'POST /v1/wechat/sticker_feedback': async (_q, body) => {
      if (!deps.stickerFeedback) return { status: 503, body: { error: 'sticker_feedback_not_wired' } }
      const b = (body ?? {}) as { chat_id?: unknown; signal?: unknown; file?: unknown }
      if (typeof b.chat_id !== 'string' || !b.chat_id.trim()) return { status: 400, body: { error: 'chat_id required (non-empty string)' } }
      if (b.signal !== 'positive' && b.signal !== 'negative') return { status: 400, body: { error: 'signal must be positive or negative' } }
      const file = deps.stickerFeedback.rate(b.chat_id.trim(), b.signal, typeof b.file === 'string' ? b.file : undefined)
      return { status: 200, body: { ok: Boolean(file), file } }
    },
    'POST /v1/wechat/send_online_sticker_candidate': async (_q, body) => {
      if (!deps.stickerSource) return { status: 503, body: { error: 'sticker_source_not_wired' } }
      const b = (body ?? {}) as { chat_id?: unknown; mood?: unknown; url?: unknown; id?: unknown }
      if (typeof b.chat_id !== 'string' || !b.chat_id.trim()) return { status: 400, body: { error: 'chat_id required (non-empty string)' } }
      if (typeof b.mood !== 'string' || !b.mood.trim()) return { status: 400, body: { error: 'mood required (non-empty string)' } }
      if (typeof b.url !== 'string' || !b.url.trim()) return { status: 400, body: { error: 'url required (non-empty string)' } }
      try {
        const host = new URL(b.url).hostname.toLowerCase()
        if (!host.endsWith('.giphy.com') && host !== 'giphy.com') return { status: 400, body: { error: 'candidate url must be a GIPHY URL' } }
      } catch { return { status: 400, body: { error: 'candidate url must be valid' } } }
      try {
        const download = await deps.stickerSource.download(b.url)
        if (!download) return { status: 200, body: { ok: false, reason: 'candidate_unavailable' } }
        const scratch = mkdtempSync(join(tmpdir(), 'online-sticker-candidate-'))
        try {
          const path = join(scratch, `${typeof b.id === 'string' && b.id ? b.id : 'candidate'}.${download.ext}`)
          writeFileSync(path, download.bytes)
          await deps.ilink.sendFile(b.chat_id.trim(), path)
          const saved = deps.stickers.save(path, [b.mood.trim()], `CC 联网筛选的「${b.mood.trim()}」表情`)
          deps.stickerFeedback?.remember(b.chat_id.trim(), saved.file)
          deps.ilink.noteSentMedia?.(b.chat_id.trim(), { kind: 'sticker', file: saved.file, label: b.mood.trim() })
          return { status: 200, body: { ok: true, source: 'online', file: saved.file } }
        } finally { rmSync(scratch, { recursive: true, force: true }) }
      } catch (err) { return { status: 200, body: { ok: false, error: errMsg(err) } } }
    },
    'POST /v1/stickers': (_q, body) => {
      const b = (body ?? {}) as { path?: unknown; tags?: unknown; desc?: unknown }
      if (typeof b.path !== 'string' || b.path.trim() === '') {
        return { status: 400, body: { error: 'path required (non-empty string)' } }
      }
      if (
        !Array.isArray(b.tags) ||
        b.tags.length === 0 ||
        !b.tags.every((t) => typeof t === 'string' && t.trim() !== '')
      ) {
        return { status: 400, body: { error: 'tags required (non-empty array of non-empty strings)' } }
      }
      if (b.desc !== undefined && typeof b.desc !== 'string') {
        return { status: 400, body: { error: 'desc must be a string' } }
      }
      try {
        const saved = deps.stickers.save(b.path, b.tags as string[], b.desc as string | undefined)
        return { status: 200, body: { ok: true, file: saved.file, tags: saved.tags } }
      } catch (err) {
        return { status: 400, body: { error: errMsg(err) } }
      }
    },
    'GET /v1/stickers': () => {
      return { status: 200, body: { ok: true, stickers: deps.stickers.list(), tags: deps.stickers.allTags() } }
    },
  }
}
