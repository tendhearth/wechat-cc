/**
 * 分享一件事给合伙人:面板上唯一认分享令牌的出口(设计稿 docs/superpowers/specs/2026-11-14-share-a-matter-design.md)。
 *
 * 分享令牌(s + 64 位 hex)不进内部 API 的令牌登记处,也不查手机路由表:它不是谁的「身份」,只是一件事的只读钥匙。
 * 所以它到不了任何别的路由 —— 面板一看到 s 开头的令牌就交到这里,这里只认三条:GET 那一页、GET 状态、POST 说一句;
 * 别的路径、别的方法、不认识 / 撤销 / 过期 / 这件事已归档,一律同一个 401,不分原因(不给人拿令牌试探的口子)。
 * 说的那一句只进这件事的对话,不进执行者的上下文;要不要照着做不在这里决定。
 * 看哪一件事由分享记录决定,请求里带什么参数都不读。
 */
import type { MatterShare } from '../../adapters/store/matter-shares'
import type { SharedMatter, ShareMode, ShareView } from '../../domain/matters/share-scope'
import { framedTooLargeFor } from '../../domain/matters/phone-scope'
import { MAX_MOBILE_DETAIL_BYTES } from './mobile-matter-response'
import type { PhoneLinkState } from './phone-link'
import { MOBILE_SHARE_HTML } from './mobile-page'

/** 面板要的分享能力(工作台服务给,wire-settings-panel.ts 接)。 */
export interface SharePort {
  create(matterId: string, name: unknown, mode?: unknown): { share: MatterShare; token: string }
  view(token: string): ShareView
  say(token: string, text: unknown): { ok: true } | { ok: false; reason: 'closed' | 'view_only' | 'invalid' | 'limit' }
  tokens(): string[]
  valid(token: string): boolean
}

export type ShareLinkResult =
  | { ok: true; share: MatterShare; url: string }
  | { ok: false; error: 'share_unavailable' }
  | { ok: false; error: 'share_relay_not_ready'; state: Exclude<PhoneLinkState, 'ready'> }

export const SHARE_STATE_PATH = '/share/state'
/** 被分享的人在这件事里说一句(「只看」的链接不行)。 */
export const SHARE_SAY_PATH = '/share/say'
const SAY_BODY_MAX = 8 * 1024
/** 被分享的人打开的那一页:壳页先取它(document.write 进去),页面再自己取上面的状态。 */
export const SHARE_PAGE_PATH = '/share'

export const isShareToken = (t: string | null | undefined): t is string => typeof t === 'string' && t.charAt(0) === 's'

/** 中继壳页上的分享链接;令牌在 # 锚点里,不上服务器。 */
export function shareUrl(remote: { relay: string; id: string }, token: string): string {
  const base = remote.relay.replace(/^wss:/, 'https:').replace(/\/v2\/phone$/, '')
  return `${base}/pset/#id=${encodeURIComponent(remote.id)}&t=${token}&p=${encodeURIComponent(SHARE_PAGE_PATH)}`
}

const json = (body: object, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const unauthorized = () => json({ error: 'unauthorized' }, 401)

/** 一帧装不下就从最早的记录起少给(记在 notesOmitted 里),标题、分工、状态不动。 */
function fitted(body: { ok: true; v: 1; name: string; mode: ShareMode; expiresAt: number; matter: SharedMatter }): object {
  let out = body
  while (out.matter.notes.length && framedTooLargeFor(JSON.stringify(out), MAX_MOBILE_DETAIL_BYTES)) {
    const drop = Math.max(1, Math.floor(out.matter.notes.length / 4))
    out = { ...out, matter: { ...out.matter, notes: out.matter.notes.slice(drop), notesOmitted: out.matter.notesOmitted + drop } }
  }
  return out
}

async function sayRequest(shares: SharePort, token: string, req: Request): Promise<Response> {
  // 先核链接再读正文:失效的链接不值得读一个字节。
  let open = false
  try { open = shares.view(token).ok } catch { /* 当成失效 */ }
  if (!open) return unauthorized()
  let text: unknown
  try {
    const raw = await req.text()
    if (raw.length > SAY_BODY_MAX) return json({ error: 'invalid_request' }, 400)
    const body = JSON.parse(raw) as unknown
    text = body && typeof body === 'object' && !Array.isArray(body) ? (body as { text?: unknown }).text : undefined
  } catch { return json({ error: 'invalid_request' }, 400) }
  const said = shares.say(token, text)
  if (said.ok) return json({ ok: true })
  if (said.reason === 'closed') return unauthorized()
  return said.reason === 'limit' ? json({ error: 'share_say_limit' }, 429) : said.reason === 'view_only' ? json({ error: 'share_view_only' }, 403) : json({ error: 'invalid_request' }, 400)
}

export async function shareRequest(shares: SharePort | undefined, url: URL, token: string, req: Request): Promise<Response> {
  if (shares && req.method === 'POST' && url.pathname === SHARE_SAY_PATH) return sayRequest(shares, token, req)
  const page = url.pathname === SHARE_PAGE_PATH
  if (!shares || req.method !== 'GET' || (!page && url.pathname !== SHARE_STATE_PATH)) return unauthorized()
  let view: ShareView
  try { view = shares.view(token) } catch { return unauthorized() }
  if (!view.ok) return unauthorized()
  // 页面本身不含这件事的任何内容,但也只给还有效的链接:失效的链接在壳页就停下。
  if (page) return new Response(MOBILE_SHARE_HTML, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } })
  return json(fitted({ ok: true, v: 1, name: view.name, mode: view.mode, expiresAt: view.expiresAt, matter: view.matter }))
}
