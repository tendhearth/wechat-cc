/**
 * mobile-letters.ts — 手机「CC 的信」的两条只读路由(手机伙伴第 2 步,2026-10-18)。路由字面量被
 * scripts/phone-routes.guard.test.ts 扫描,新增 / 改名要同步 PHONE_ROUTES 与 PHONE_API_SCHEMAS。
 *
 * - GET /m/api/letters:寄出去了的信,新的在前(日期 + 开头那句 + 几页);排不成图的那封带全文。
 * - GET /m/api/letters/page?id=<信>&p=<第几页,1 起>&offset=<字节>:一页 PNG 按块读(与 /m/api/chat/file 同一个切块)。
 *
 * 信是私事:只给设备令牌(配过对的主人手机);/set 链接令牌(10 分钟、可能随 URL 外泄)不在册(phone-routes.ts 的
 * LINK_ROUTES 拿掉了这两条)。手机只给 id + 页码,路径永远在 daemon 这边拼、只认存档里的形状。正文不进日志。
 */
import { framedTooLarge } from './mobile-matter-response'
import { fileChunkResponse } from './mobile-chat'
import type { LetterListItem } from './letters/archive'

export interface MobileLettersDeps {
  list(): LetterListItem[]
  /** 寄出去了的那封的第 page 页;没有 ⇒ null。 */
  pagePath(id: string, page: number): string | null
}

const json = (body: object, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const err = (error: string, status: number) => json({ ok: false, error }, status)

export async function mobileLettersRoute(deps: MobileLettersDeps | undefined, url: URL, req: Request): Promise<Response | null> {
  if (url.pathname === '/m/api/letters') {
    if (req.method !== 'GET') return err('method_not_allowed', 405)
    if (!deps) return err('letters_not_wired', 503)
    let letters: LetterListItem[]
    try { letters = deps.list() } catch { return err('unavailable', 503) }
    // 一帧装不下(很多封按文字寄的长信)⇒ 从最旧那头少给;最新的总在。
    let body = JSON.stringify({ ok: true, letters })
    while (letters.length > 1 && framedTooLarge(body)) {
      letters = letters.slice(0, Math.max(1, Math.floor(letters.length * 0.75)))
      body = JSON.stringify({ ok: true, letters })
    }
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
  }
  if (url.pathname === '/m/api/letters/page') {
    if (req.method !== 'GET') return err('method_not_allowed', 405)
    if (!deps) return err('letters_not_wired', 503)
    const id = url.searchParams.get('id'), rawPage = url.searchParams.get('p'), rawOffset = url.searchParams.get('offset') ?? '0'
    if (!id || id.length > 64 || rawPage === null || !/^\d{1,2}$/.test(rawPage) || !/^\d{1,9}$/.test(rawOffset)) return err('invalid', 400)
    let path: string | null
    try { path = deps.pagePath(id, Number(rawPage)) } catch { return err('unavailable', 503) }
    if (!path) return err('not_found', 404)
    return fileChunkResponse(path, `${id}-${Number(rawPage)}.png`, Number(rawOffset))
  }
  return null
}
