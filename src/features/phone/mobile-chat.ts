import { CHAT_PAGE_MAX, CHAT_TEXT_MAX, PHONE_CHAT_MAX_IMAGES, PHONE_SAY_MAX_CHARS } from '@wechat-cc/protocol'
import type { MessageRecord } from '../../lib/messages-store'
import type { MatterOrigin, MatterStore } from '../../ports/matters'
import type { ChatJob, PhoneChat } from './phone-chat'
import { framedTooLarge } from './mobile-matter-response'
import { ownsMethod, sharedRoute, type PhoneRouteTable } from '../../lib/phone-route-table'
import { parseExtras, phoneExtrasFields, incomingUploadAttachments } from '../../daemon/app-reply'
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'

/** CC 回复里的文件在手机上读(2026-10-06):每块 128 KiB,整份 ≤ 20MB;只读普通文件,不跟符号链接。 */
export const CHAT_FILE_CHUNK_BYTES = 128 * 1024
export const CHAT_FILE_MAX_BYTES = 20 * 1024 * 1024
const MIME_BY_EXT: Record<string, string> = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  md: 'text/markdown', txt: 'text/plain', csv: 'text/csv', json: 'application/json', html: 'text/html', htm: 'text/html',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', zip: 'application/zip' }
const mimeOf = (name: string) => MIME_BY_EXT[(/\.([A-Za-z0-9]+)$/.exec(name)?.[1] ?? '').toLowerCase()] ?? 'application/octet-stream'
/** 整份读出来再切(≤20MB):sha256 让手机核对拼起来的是同一份;读的时候文件被换了 ⇒ 长度 / 哈希对不上,手机会报「刚换了」。
 *  一份文件分很多块来读:按「规范路径 + 文件身份 + 大小 + 修改/变更时间」缓存最近一份,60 秒内同一份不重读不重算(换了文件自然失效)。 */
let fileCache: { key: string; at: number; bytes: Buffer; sha256: string } | null = null
function readChatFile(path: string, now = Date.now()): { bytes: Buffer; sha256: string } {
  // Canonicalize once, then verify both identity and path after opening and reading.
  // System aliases such as macOS /var remain usable; the final component may not be a symlink.
  const before = lstatSync(path), canonical = realpathSync(path)
  if (!before.isFile()) throw new Error('not_a_file')
  const fd = openSync(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const opened = fstatSync(fd)
    const same = (a: typeof opened, b: typeof opened) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
    if (!opened.isFile() || !same(before, opened) || realpathSync(path) !== canonical || !same(lstatSync(path), opened)) throw new Error('not_a_file')
    if (opened.size > CHAT_FILE_MAX_BYTES) throw new Error('too_large')
    const key = `${canonical}\u0000${opened.dev}:${opened.ino}:${opened.size}:${opened.mtimeMs}:${opened.ctimeMs}`
    if (fileCache && fileCache.key === key && now - fileCache.at < 60_000) return fileCache
    const bytes = Buffer.alloc(opened.size)
    let at = 0
    while (at < bytes.length) { const n = readSync(fd, bytes, at, bytes.length - at, at); if (!n) break; at += n }
    if (at !== bytes.length || !same(opened, fstatSync(fd)) || realpathSync(path) !== canonical || !same(opened, lstatSync(path))) throw new Error('not_a_file')
    fileCache = {key, at:now, bytes, sha256:createHash('sha256').update(bytes).digest('hex')}
    return fileCache
  } finally { closeSync(fd) }
}

/**
 * 磁盘上的一份文件按块回给手机(chat/file 与 letters/page 共用,2026-10-18 抽出来):每块 128 KiB(base64 后
 * 远小于中继一帧 512 KiB),带整份的 size + sha256,手机拼完核对。offset 由调用方先验成非负整数。
 */
export function fileChunkResponse(path: string, name: string, offset: number): Response {
  let file: { bytes: Buffer; sha256: string }
  try { file = readChatFile(path) } catch (e) {
    const m = e instanceof Error ? e.message : ''
    return m === 'too_large' ? err('too_large', 413) : err('not_found', 404)
  }
  const { bytes, sha256 } = file
  if (offset > bytes.length) return err('invalid', 400)
  const end = Math.min(bytes.length, offset + CHAT_FILE_CHUNK_BYTES)
  return json({ ok: true, name, mime: mimeOf(name), size: bytes.length, sha256, offset, nextOffset: end, contentBase64: bytes.subarray(offset, end).toString('base64') })
}

/**
 * mobile-chat.ts — 手机「跟 CC 说」的两条路由(spec 2026-10-01 §3)。表里的键由
 * scripts/phone-routes.guard.test.ts 对着路由表核对,新增 / 改名要同步 routes.ts 与 PHONE_API_SCHEMAS。
 *
 * - GET 只读(Ruling 3):`owner()` 只查主人那条 chat matter,不建、不登记露面。
 * - say 收下即回:`chat.say` 抛 'no_owner_chat' | 'chat_busy' | 'input_conflict';回复由接线方给的
 *   converse(companionConverse —— 与微信 / 桌面同一条回合串行入口)在后台跑。
 * - 正文不进日志。
 * - 回复行的附件与旁白(messages.extras,2026-10-04)随行带出;文件只给名字。语音不进页:
 *   `GET /m/api/chat/voice?id=<消息 id>&i=<第几个附件>` 按需合成 —— 只合成库里那一行真有的那段语音,
 *   不是一个「给什么字都念」的口子。
 */
export interface MobileChatDeps {
  inboxDir?:string
  /** 只读:主人的 chat matter;没有就 null(⇒ 404 no_owner_chat)。 */
  owner(): { matterId: string; chatId: string; title: string } | null
  /** 升序;有 beforeTs 时是「严格早于它的最后 limit 条」。 */
  history(chatId: string, opts: { beforeTs?: string; limit: number }): Promise<MessageRecord[]>
  chat: PhoneChat
  /** 主人对话里的一行(必须属于这个 chat);语音路由用它找那段要念的话。 */
  message?(chatId: string, id: string): Promise<MessageRecord | null>
  /** 合成语音(与桌面 agent_speak 同一个 synthesizeSpeech)。没接 ⇒ 语音路由 503。 */
  speak?(text: string): Promise<{ audio: Buffer; mime: string }>
  /** 只读:电脑上配没配语音转文字(手机按钮先说清楚,不等录完才失败)。 */
  transcribeStatus?(): { configured: boolean }
  /** 主人对话用哪个后端 / 模型(2026-10-06,与微信 `/api <模型>` 同一处:按对话钉 Mode.solo)。没接 ⇒ 503。 */
  model?: {
    current(chatId: string): ChatModelView
    set(chatId: string, provider: string, model: string | null): void
  }
}

export interface ChatModelView {
  /** 'solo' 才有单一的 provider / model;多人模式(parallel / chatroom …)照实报,切换会改回 solo。 */
  mode: string
  provider: string
  /** 这个对话钉的模型;null = 用这个后端的全局设置(globalModel)。 */
  model: string | null
  globalModel: string | null
  providers: Array<{ id: string; name: string }>
}
/** 模型名:字母数字与 . _ / : - [ ](claude 的 `[1m]`),1–120 字,不能有空格。 */
const MODEL_ID = /^[A-Za-z0-9._/:[\]-]{1,120}$/

/** 主人 chat matter 的两种取法:peek 只读(GET 用),ensure 建 / 找并登记手机露面(说一句用)。 */
export function makePhoneOwner(d: {
  ownerChatId(): string | null
  matters: Pick<MatterStore, 'findChat' | 'ensureChat' | 'bind'>
  /** 主人对话要是在手机上首建:出生地(原生 App / 浏览器,按传输判)。没给 / 不知道 ⇒ 不写。 */
  origin?: () => MatterOrigin | null
}): { peek(): { matterId: string; chatId: string; title: string } | null; ensure(): string | null } {
  return {
    peek() {
      const chatId = d.ownerChatId()
      if (!chatId) return null
      const m = d.matters.findChat(chatId)
      return m ? { matterId: m.id, chatId, title: m.title } : null
    },
    ensure() {
      const chatId = d.ownerChatId()
      if (!chatId) return null
      const m = d.matters.ensureChat(chatId, undefined, d.origin?.() ?? null)
      try { d.matters.bind(m.id, 'phone', 'pwa') } catch { /* 只是露面登记 */ }
      return m.id
    },
  }
}

/**
 * 手机对话认的主人 chat:必须就是 companionConverse 写进去的那条(它认 companion 的 default_chat_id)。
 * 两者不一致(default_chat_id 不是 admin)⇒ 当作没有主人对话,免得手机看 A 却说进 B;
 * 这种停用在状态切换时记一行日志(不记 chat id),否则手机只显示「还没设好主人对话」、日志里毫无线索。
 */
export function makePhoneChatId(d: { ownerChatId(): string | null; converseChatId(): string | null; log?: (tag: string, line: string) => void }): () => string | null {
  let mismatched = false
  const note = (line: string) => { try { d.log?.('PHONE_CHAT', line) } catch { /* 日志坏了不影响结果 */ } }
  return () => {
    const id = d.ownerChatId()
    if (!id) return null
    const conv = d.converseChatId()
    const bad = !!conv && conv !== id
    if (bad !== mismatched) {
      mismatched = bad
      note(bad ? 'companion default_chat_id is not the admin chat — phone chat disabled' : 'companion default_chat_id matches the admin chat again — phone chat enabled')
    }
    return bad ? null : id
  }
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const json = (body: object, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const err = (error: string, status: number) => json({ ok: false, error }, status)
/** 线上的 job 不带 matterId(外层已有)。 */
const wireJob = ({ requestId, text, status, since, error }: ChatJob) => ({ requestId, text, status, since, ...(error ? { error } : {}) })
const sourceOf = (s: string): 'wechat' | 'desktop' | 'phone' => (s === 'desktop' || s === 'phone' ? s : 'wechat')
const message = (r: MessageRecord, inboxDir?:string) => ({
  id: r.id, role: r.direction === 'in' ? 'me' as const : 'cc' as const, kind: r.kind,
  text: r.text.length > CHAT_TEXT_MAX ? r.text.slice(0, CHAT_TEXT_MAX) : r.text, truncated: r.text.length > CHAT_TEXT_MAX,
  at: Date.parse(r.ts), source: sourceOf(r.source),
  ...(r.direction === 'out' ? phoneExtrasFields(r.extras) : incomingUploadAttachments(r,inboxDir).length ? {attachments:incomingUploadAttachments(r,inboxDir).map(({name})=>({kind:'file' as const,name}))} : {}),
})

export function mobileChatRoutes(deps: MobileChatDeps | undefined): PhoneRouteTable {
  return {
    'GET /v1/matter/owner-chat/page': ownsMethod(async (url: URL, req: Request) => {
      if (req.method !== 'GET') return err('method_not_allowed', 405)
      if (!deps) return err('chat_not_wired', 503)
      const rawLimit = url.searchParams.get('limit'), before = url.searchParams.get('before'), requestId = url.searchParams.get('requestId')
      if (requestId !== null && !UUID.test(requestId)) return err('invalid', 400)
      if (rawLimit !== null && (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > CHAT_PAGE_MAX)) return err('invalid', 400)
      if (before !== null && (before.length > 64 || !Number.isFinite(Date.parse(before)))) return err('invalid', 400)
      let owner: ReturnType<MobileChatDeps['owner']>
      try { owner = deps.owner() } catch { return err('unavailable', 503) }
      if (!owner) return err('no_owner_chat', 404)
      const limit = rawLimit === null ? CHAT_PAGE_MAX : Number(rawLimit)
      let rows: MessageRecord[]
      // 多取一条判 hasMore。listRange 是严格 `<` beforeTs:同一毫秒的两条恰好跨页边界时会漏一条(可接受,见 preflight B7)。
      try { rows = await deps.history(owner.chatId, { ...(before !== null ? { beforeTs: before } : {}), limit: limit + 1 }) }
      catch { return err('unavailable', 503) }
      try { const current = deps.owner(); if (!current || current.chatId !== owner.chatId || current.matterId !== owner.matterId) return err('no_owner_chat', 404) } catch { return err('unavailable', 503) }
      let hasMore = rows.length > limit
      let page = hasMore ? rows.slice(rows.length - limit) : rows   // rows 升序:多出来的是最旧那条
      const st = deps.chat.state()
      const build = () => JSON.stringify({
        ok: true, conversation: 'v1', topics: 'v1', matterId: owner!.matterId, title: owner!.title, messages: page.map(row=>message(row,deps.inboxDir)), hasMore,
        // 原始 ts 字符串,不重新格式化 —— 下一页原样当 before 传回来。
        nextBefore: hasMore && page.length ? page[0]!.ts : null,
        pending: st.pending ? wireJob(st.pending) : null, failed: st.failed ? wireJob(st.failed) : null,
        ...(requestId ? { receipt: deps.chat.receipt?.(requestId) ?? null } : {}),
      })
      // 旧中继一帧 512 KiB(终审 M1):整页太大就从最旧那头少给几条(hasMore + nextBefore 接着翻,不留洞),绝不 413 整页。
      // 单条至多 CHAT_TEXT_MAX 字,最坏转义后也远小于预算,所以总留得下最新那条。
      let body = build()
      while (page.length > 1 && framedTooLarge(body)) {
        page = page.slice(Math.max(1, Math.floor(page.length / 8)))
        hasMore = true
        body = build()
      }
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
    }),
    // 搜主人那条对话(2026-10-06,对标 Orca 会话历史搜索):q 1–200 字;最多 30 条、每条截到 600 字(一帧装得下)。
    // 这条对话用哪个后端 / 模型(2026-10-06,对标 Paseo / Orca 手机上换模型):读 + 钉(只影响主人这条对话,下一句生效)。
    ...sharedRoute(['GET', 'POST'], '/v1/matter/owner-chat/model', ownsMethod(async (url: URL, req: Request) => {
      if (!deps?.model) return err('model_not_wired', 503)
      let owner: ReturnType<MobileChatDeps['owner']>
      try { owner = deps.owner() } catch { return err('unavailable', 503) }
      if (!owner) return err('no_owner_chat', 404)
      if (req.method === 'GET') {
        try { return json({ ok: true, ...deps.model.current(owner.chatId) }) } catch { return err('unavailable', 503) }
      }
      if (req.method !== 'POST') return err('method_not_allowed', 405)
      let body: unknown
      try { body = await req.json() } catch { return err('bad_json', 400) }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return err('invalid', 400)
      const b = body as Record<string, unknown>
      if (Object.keys(b).some(k => k !== 'provider' && k !== 'model')) return err('invalid', 400)
      if (typeof b.provider !== 'string' || (b.model !== null && b.model !== undefined && (typeof b.model !== 'string' || !MODEL_ID.test(b.model)))) return err('invalid', 400)
      let view: ChatModelView
      try { view = deps.model.current(owner.chatId) } catch { return err('unavailable', 503) }
      if (!view.providers.some(p => p.id === b.provider)) return err('unknown_provider', 400)
      try { deps.model.set(owner.chatId, b.provider, typeof b.model === 'string' ? b.model : null) } catch { return err('unavailable', 503) }
      return json({ ok: true, ...deps.model.current(owner.chatId) })
    })),
    'GET /v1/matter/owner-chat/voice': ownsMethod(async (url: URL, req: Request) => {
      if (req.method !== 'GET') return err('method_not_allowed', 405)
      if (!deps?.message || !deps.speak) return err('voice_not_wired', 503)
      const id = url.searchParams.get('id'), rawIdx = url.searchParams.get('i')
      if (!id || id.length > 200 || rawIdx === null || !/^\d{1,2}$/.test(rawIdx)) return err('invalid', 400)
      let owner: ReturnType<MobileChatDeps['owner']>
      try { owner = deps.owner() } catch { return err('unavailable', 503) }
      if (!owner) return err('no_owner_chat', 404)
      let row: MessageRecord | null
      try { row = await deps.message(owner.chatId, id) } catch { return err('unavailable', 503) }
      const att = row && row.direction === 'out' ? parseExtras(row.extras)?.attachments[Number(rawIdx)] : undefined
      if (!att || att.kind !== 'voice') return err('not_found', 404)
      let audio: { audio: Buffer; mime: string }
      try { audio = await deps.speak(att.text) } catch (e) {
        const m = e instanceof Error ? e.message : ''
        return /no.?voice.?config|not configured/i.test(m) ? err('no_voice_config', 422) : err('unavailable', 503)
      }
      const body = JSON.stringify({ ok: true, mime: audio.mime, data: audio.audio.toString('base64') })
      // 一帧装不下(很长的一段)⇒ 413,手机提示去电脑上听;不切片(语音附件本来就 ≤ 500 字)。
      if (framedTooLarge(body)) return err('too_large', 413)
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
    }),
    // 按住说话(2026-10-18):GET 只问电脑上配没配语音转文字(手机按钮先说清楚,不等录完才失败)。
    // 录音转成字那一条(POST)P3c-1 并进了 POST /v1/companion/transcribe,旧路径是别名(legacy-routes.ts)。
    'GET /v1/companion/transcribe': ownsMethod(async (_url: URL, req: Request) => {
      if (req.method !== 'GET') return err('method_not_allowed', 405)
      if (!deps?.transcribeStatus) return err('voice_not_wired', 503)
      try { return json({ ok: true, configured: deps.transcribeStatus().configured === true }) } catch { return err('unavailable', 503) }
    }),
    'POST /v1/matter/owner-chat/say': ownsMethod(async (url: URL, req: Request) => {
      if (req.method !== 'POST') return err('method_not_allowed', 405)
      if (!deps) return err('chat_not_wired', 503)
      let body: unknown
      try { body = await req.json() } catch { return err('bad_json', 400) }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return err('invalid', 400)
      const b = body as Record<string, unknown>
      // 白名单:requestId、text,以及带图时的 draftId + attachmentIds(2026-10-06,最多 4 张;有图时文字可空)。
      if (Object.keys(b).some(k => !['requestId', 'text', 'draftId', 'attachmentIds'].includes(k))) return err('invalid', 400)
      const ids = b.attachmentIds
      const hasImages = Array.isArray(ids) && ids.length > 0
      if (ids !== undefined && (!Array.isArray(ids) || ids.length > PHONE_CHAT_MAX_IMAGES || ids.some(id => typeof id !== 'string' || !UUID.test(id)) || new Set(ids).size !== ids.length)) return err('invalid_attachment', 400)
      if (hasImages !== (typeof b.draftId === 'string') || (b.draftId !== undefined && (typeof b.draftId !== 'string' || !UUID.test(b.draftId)))) return err('invalid_attachment', 400)
      if (typeof b.requestId !== 'string' || !UUID.test(b.requestId) || typeof b.text !== 'string' || (!b.text.trim() && !hasImages) || b.text.length > PHONE_SAY_MAX_CHARS) return err('invalid', 400)
      try {
        const job = deps.chat.say(b.requestId, b.text, hasImages ? { draftId: (b.draftId as string).toLowerCase(), attachmentIds: (ids as string[]).map(id => id.toLowerCase()) } : undefined)
        return json({ ok: true, matterId: job.matterId, job: wireJob(job) })
      } catch (e) {
        const m = e instanceof Error ? e.message : ''
        if (m === 'chat_busy') return err('chat_busy', 409)
        if (m === 'input_conflict') return err('input_conflict', 409)
        if (m === 'no_owner_chat') return err('no_owner_chat', 404)
        // 图:不存在 / 过期 / 不是这位主人的 / 不是图片 ⇒ 让手机重新传;还没接 ⇒ 老 daemon 一样的「不支持」。
        if (['invalid_attachment', 'attachment_scope', 'not_found', 'attachment_changed', 'invalid_attachment_size', 'invalid_entry_owner'].includes(m)) return err('invalid_attachment', 409)
        if (m === 'images_not_wired') return err('images_not_supported', 409)
        // Ruling 7:内部意外按「暂时不可用」回 503(手机映射成 unavailable),不是 500。
        return err('unavailable', 503)
      }
    }),
  }
}
