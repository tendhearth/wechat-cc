import { CHAT_PAGE_MAX, CHAT_TEXT_MAX, PHONE_CHAT_MAX_IMAGES, PHONE_SAY_MAX_CHARS } from '@wechat-cc/protocol'
import type { MessageRecord } from '../lib/messages-store'
import type { MatterStore } from '../core/matters/store'
import type { ChatJob, PhoneChat } from './phone-chat'
import { framedTooLarge } from './mobile-matter-response'
import { parseExtras, phoneExtrasFields } from './app-reply'
import { createHash } from 'node:crypto'
import { closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs'

/** CC 回复里的文件在手机上读(2026-10-06):每块 128 KiB,整份 ≤ 20MB;只读普通文件,不跟符号链接。 */
export const CHAT_FILE_CHUNK_BYTES = 128 * 1024
export const CHAT_FILE_MAX_BYTES = 20 * 1024 * 1024
const MIME_BY_EXT: Record<string, string> = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  md: 'text/markdown', txt: 'text/plain', csv: 'text/csv', json: 'application/json', html: 'text/html', htm: 'text/html',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', zip: 'application/zip' }
const mimeOf = (name: string) => MIME_BY_EXT[(/\.([A-Za-z0-9]+)$/.exec(name)?.[1] ?? '').toLowerCase()] ?? 'application/octet-stream'
/** 整份读出来再切(≤20MB):sha256 让手机核对拼起来的是同一份;读的时候文件被换了 ⇒ 长度 / 哈希对不上,手机会报「刚换了」。
 *  一份文件分很多块来读:按「路径 + 大小 + 修改时间」缓存最近一份,60 秒内同一份不重读不重算(换了文件自然失效)。 */
let fileCache: { key: string; at: number; bytes: Buffer; sha256: string } | null = null
function readChatFile(path: string, now = Date.now()): { bytes: Buffer; sha256: string } {
  const st = lstatSync(path)
  if (!st.isFile()) throw new Error('not_a_file')
  if (st.size > CHAT_FILE_MAX_BYTES) throw new Error('too_large')
  const key = `${path}\u0000${st.size}\u0000${st.mtimeMs}`
  if (fileCache && fileCache.key === key && now - fileCache.at < 60_000) return fileCache
  const bytes = readWholeFile(path)
  fileCache = { key, at: now, bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
  return fileCache
}
function readWholeFile(path: string): Buffer {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    if (size > CHAT_FILE_MAX_BYTES) throw new Error('too_large')
    const buf = Buffer.alloc(size)
    let at = 0
    while (at < size) { const n = readSync(fd, buf, at, size - at, at); if (!n) break; at += n }
    return buf.subarray(0, at)
  } finally { closeSync(fd) }
}

/**
 * mobile-chat.ts — 手机「跟 CC 说」的两条路由(spec 2026-10-01 §3)。路由字面量被
 * scripts/phone-routes.guard.test.ts 扫描,新增 / 改名要同步 PHONE_ROUTES 与 PHONE_API_SCHEMAS。
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
  /** 只读:主人的 chat matter;没有就 null(⇒ 404 no_owner_chat)。 */
  owner(): { matterId: string; chatId: string; title: string } | null
  /** 升序;有 beforeTs 时是「严格早于它的最后 limit 条」。 */
  history(chatId: string, opts: { beforeTs?: string; limit: number }): Promise<MessageRecord[]>
  chat: PhoneChat
  /** 主人对话里的一行(必须属于这个 chat);语音路由用它找那段要念的话。 */
  message?(chatId: string, id: string): Promise<MessageRecord | null>
  /** 在主人对话里搜(2026-10-06);新的在前。没接 ⇒ 搜索路由 503。 */
  search?(chatId: string, query: string, limit: number): Promise<MessageRecord[]>
  /** 合成语音(与桌面 agent_speak 同一个 synthesizeSpeech)。没接 ⇒ 语音路由 503。 */
  speak?(text: string): Promise<{ audio: Buffer; mime: string }>
}

/** 主人 chat matter 的两种取法:peek 只读(GET 用),ensure 建 / 找并登记手机露面(说一句用)。 */
export function makePhoneOwner(d: {
  ownerChatId(): string | null
  matters: Pick<MatterStore, 'findChat' | 'ensureChat' | 'bind'>
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
      const m = d.matters.ensureChat(chatId)
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
const message = (r: MessageRecord) => ({
  id: r.id, role: r.direction === 'in' ? 'me' as const : 'cc' as const, kind: r.kind,
  text: r.text.length > CHAT_TEXT_MAX ? r.text.slice(0, CHAT_TEXT_MAX) : r.text, truncated: r.text.length > CHAT_TEXT_MAX,
  at: Date.parse(r.ts), source: sourceOf(r.source),
  ...(r.direction === 'out' ? phoneExtrasFields(r.extras) : {}),
})

export async function mobileChatRoute(deps: MobileChatDeps | undefined, url: URL, req: Request): Promise<Response | null> {
  if (url.pathname === '/m/api/chat') {
    if (req.method !== 'GET') return err('method_not_allowed', 405)
    if (!deps) return err('chat_not_wired', 503)
    const rawLimit = url.searchParams.get('limit'), before = url.searchParams.get('before')
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
    let hasMore = rows.length > limit
    let page = hasMore ? rows.slice(rows.length - limit) : rows   // rows 升序:多出来的是最旧那条
    const st = deps.chat.state()
    const build = () => JSON.stringify({
      ok: true, matterId: owner!.matterId, title: owner!.title, messages: page.map(message), hasMore,
      // 原始 ts 字符串,不重新格式化 —— 下一页原样当 before 传回来。
      nextBefore: hasMore && page.length ? page[0]!.ts : null,
      pending: st.pending ? wireJob(st.pending) : null, failed: st.failed ? wireJob(st.failed) : null,
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
  }
  // 搜主人那条对话(2026-10-06,对标 Orca 会话历史搜索):q 1–200 字;最多 30 条、每条截到 600 字(一帧装得下)。
  if (url.pathname === '/m/api/chat/search') {
    if (req.method !== 'GET') return err('method_not_allowed', 405)
    if (!deps?.search) return err('chat_not_wired', 503)
    const q = url.searchParams.get('q') ?? ''
    if (url.searchParams.getAll('q').length !== 1 || !q.trim() || q.length > 200) return err('invalid', 400)
    let owner: ReturnType<MobileChatDeps['owner']>
    try { owner = deps.owner() } catch { return err('unavailable', 503) }
    if (!owner) return err('no_owner_chat', 404)
    let rows: MessageRecord[]
    try { rows = await deps.search(owner.chatId, q.trim(), 30) } catch { return err('unavailable', 503) }
    const hits = rows.map(r => ({ id: r.id, role: r.direction === 'in' ? 'me' : 'cc', text: r.text.length > 600 ? r.text.slice(0, 600) : r.text, truncated: r.text.length > 600, at: Date.parse(r.ts), source: r.source ?? null }))
    return json({ ok: true, hits })
  }
  // CC 回复里的文件(2026-10-06):按消息 id + 第几个附件定位(手机不给路径),必须是这条主人对话里 CC 发的那一行。
  if (url.pathname === '/m/api/chat/file') {
    if (req.method !== 'GET') return err('method_not_allowed', 405)
    if (!deps?.message) return err('chat_not_wired', 503)
    const id = url.searchParams.get('id'), rawIdx = url.searchParams.get('i'), rawOffset = url.searchParams.get('offset') ?? '0'
    if (!id || id.length > 200 || rawIdx === null || !/^\d{1,2}$/.test(rawIdx) || !/^\d{1,9}$/.test(rawOffset)) return err('invalid', 400)
    let owner: ReturnType<MobileChatDeps['owner']>
    try { owner = deps.owner() } catch { return err('unavailable', 503) }
    if (!owner) return err('no_owner_chat', 404)
    let row: MessageRecord | null
    try { row = await deps.message(owner.chatId, id) } catch { return err('unavailable', 503) }
    const att = row && row.direction === 'out' ? parseExtras(row.extras)?.attachments[Number(rawIdx)] : undefined
    if (!att || att.kind !== 'file') return err('not_found', 404)
    let file: { bytes: Buffer; sha256: string }
    try { file = readChatFile(att.path) } catch (e) {
      const m = e instanceof Error ? e.message : ''
      return m === 'too_large' ? err('too_large', 413) : err('not_found', 404)
    }
    const { bytes, sha256 } = file
    const offset = Number(rawOffset)
    if (offset > bytes.length) return err('invalid', 400)
    const end = Math.min(bytes.length, offset + CHAT_FILE_CHUNK_BYTES)
    return json({ ok: true, name: att.name, mime: mimeOf(att.name), size: bytes.length, sha256, offset, nextOffset: end, contentBase64: bytes.subarray(offset, end).toString('base64') })
  }
  if (url.pathname === '/m/api/chat/voice') {
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
  }
  if (url.pathname === '/m/api/chat/say') {
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
  }
  return null
}
