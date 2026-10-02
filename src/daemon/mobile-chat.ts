import { CHAT_PAGE_MAX, CHAT_TEXT_MAX, PHONE_SAY_MAX_CHARS } from '@wechat-cc/protocol'
import type { MessageRecord } from '../lib/messages-store'
import type { MatterStore } from '../core/matters/store'
import type { ChatJob, PhoneChat } from './phone-chat'
import { framedTooLarge } from './mobile-matter-response'

/**
 * mobile-chat.ts — 手机「跟 CC 说」的两条路由(spec 2026-10-01 §3)。路由字面量被
 * scripts/phone-routes.guard.test.ts 扫描,新增 / 改名要同步 PHONE_ROUTES 与 PHONE_API_SCHEMAS。
 *
 * - GET 只读(Ruling 3):`owner()` 只查主人那条 chat matter,不建、不登记露面。
 * - say 收下即回:`chat.say` 抛 'no_owner_chat' | 'chat_busy' | 'input_conflict';回复由接线方给的
 *   converse(companionConverse —— 与微信 / 桌面同一条回合串行入口)在后台跑。
 * - 正文不进日志。
 */
export interface MobileChatDeps {
  /** 只读:主人的 chat matter;没有就 null(⇒ 404 no_owner_chat)。 */
  owner(): { matterId: string; chatId: string; title: string } | null
  /** 升序;有 beforeTs 时是「严格早于它的最后 limit 条」。 */
  history(chatId: string, opts: { beforeTs?: string; limit: number }): Promise<MessageRecord[]>
  chat: PhoneChat
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
  if (url.pathname === '/m/api/chat/say') {
    if (req.method !== 'POST') return err('method_not_allowed', 405)
    if (!deps) return err('chat_not_wired', 503)
    let body: unknown
    try { body = await req.json() } catch { return err('bad_json', 400) }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return err('invalid', 400)
    const b = body as Record<string, unknown>
    // 白名单:只认 requestId、text。
    if (Object.keys(b).some(k => k !== 'requestId' && k !== 'text')) return err('invalid', 400)
    if (typeof b.requestId !== 'string' || !UUID.test(b.requestId) || typeof b.text !== 'string' || !b.text.trim() || b.text.length > PHONE_SAY_MAX_CHARS) return err('invalid', 400)
    try {
      const job = deps.chat.say(b.requestId, b.text)
      return json({ ok: true, matterId: job.matterId, job: wireJob(job) })
    } catch (e) {
      const m = e instanceof Error ? e.message : ''
      if (m === 'chat_busy') return err('chat_busy', 409)
      if (m === 'input_conflict') return err('input_conflict', 409)
      if (m === 'no_owner_chat') return err('no_owner_chat', 404)
      // Ruling 7:内部意外按「暂时不可用」回 503(手机映射成 unavailable),不是 500。
      return err('unavailable', 503)
    }
  }
  return null
}
