import { framedTooLarge } from './mobile-matter-response'
import { ownsMethod, type PhoneRouteTable } from './phone-route-table'
import { PHONE_CLI_SAY_MAX, type CliPhoneActions } from '../terminal'

/**
 * mobile-reads.ts — 手机只读路由(spec 2026-10-01 §3):终端会话看着它跑 / 拍板 / 说一句。
 * 表里的键由 scripts/phone-routes.guard.test.ts 对着路由表核对。CC 的连接、终端会话列表、「今天」P3c-2 并进了
 * `/v1/connections`、`/v1/cli/sessions`、`/v1/overseer/today`;电脑上的原生会话两条 P3c-4 并进了 `/v1/workbench/sessions`、
 * `/v1/workbench/session`(手机那一份由处理器按 caller 收,单飞 + 短缓存在 features/workbench/phone-sessions.ts;旧路径是 legacy-routes.ts 的别名)。
 */
export interface MobileReadsDeps {
  cliActions?: CliPhoneActions
}
/** 同 CliEventRequest:1–200 字的串;再挡掉控制字符。 */
const SESSION_ID_RE = /^[^\u0000-\u001f]{1,200}$/
const HASH_RE = /^[a-z0-9]{5}$/
async function bodyOf(req: Request): Promise<Record<string, unknown> | null> {
  try { const b = await req.json(); return b && typeof b === 'object' && !Array.isArray(b) ? b as Record<string, unknown> : null } catch { return null }
}
const json = (body: object, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

/**
 * 旧中继一帧 512 KiB(终审 M1):body 由 build(max) 生成,太大就把每段正文的上限减半再生成(不删条目、不动 cursor),
 * 绝不 413 整页。max 降到 64 仍超(条目本身就多到离谱)也照发 —— 那是中继的事,不是吞掉整页。
 */
function fitted(build: (max: number) => object, max: number): Response {
  let body = JSON.stringify(build(max))
  while (max > 64 && framedTooLarge(body)) { max = Math.floor(max / 2); body = JSON.stringify(build(max)) }
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}

export function mobileReadsRoutes(deps: MobileReadsDeps): PhoneRouteTable {
  return {
    // 看着它跑(2026-10-17):一条终端会话最近几步。手机展开那一行时每几秒拉一次;只读,和「看 码」同一份记录。
    'GET /m/api/cli/activity': ownsMethod(async (url: URL, req: Request) => {
      if (req.method !== 'GET') return json({ ok: false, error: 'method_not_allowed' }, 405)
      if (!deps.cliActions) return json({ ok: false, error: 'cli_actions_not_wired' }, 503)
      const id = url.searchParams.get('session_id')
      if (!id || !SESSION_ID_RE.test(id) || url.searchParams.getAll('session_id').length > 1) return json({ ok: false, error: 'invalid' }, 400)
      try {
        const r = deps.cliActions.activity(id)
        if (!r.ok) return json({ ok: false, error: r.error }, r.error === 'not_found' ? 404 : 409)
        // 旧中继一帧 512 KiB:每步文字上限减半直到放得下(不删步)。
        const cut = (t: string, max: number) => (t.length > max ? t.slice(0, max - 1) + '…' : t)
        return fitted(max => ({ ok: true, items: r.items.map(i => ({ ...i, text: cut(i.text, max), ...(i.detail ? { detail: cut(i.detail, max * 3) } : {}) })) }), 600)
      } catch { return json({ ok: false, error: 'unavailable' }, 503) }
    }),
    // 拍板终端会话等批准的那一项 —— 与微信「y/n 码」同一条路(features/terminal/phone-actions.ts)。
    'POST /m/api/cli/permission': ownsMethod(async (url: URL, req: Request) => {
      if (req.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405)
      if (!deps.cliActions) return json({ ok: false, error: 'cli_actions_not_wired' }, 503)
      const b = await bodyOf(req)
      const hash = b?.['hash'], sessionId = b?.['session_id'], decision = b?.['decision']
      if (!b || (decision !== 'allow' && decision !== 'deny')
        || (hash !== undefined && (typeof hash !== 'string' || !HASH_RE.test(hash)))
        || (sessionId !== undefined && (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)))
        || (hash === undefined && sessionId === undefined)) return json({ ok: false, error: 'invalid' }, 400)
      try {
        const r = deps.cliActions.permission({ ...(typeof hash === 'string' ? { hash } : {}), ...(typeof sessionId === 'string' ? { session_id: sessionId } : {}) }, decision)
        if (r.ok) return json({ ok: true })
        return json({ ok: false, error: r.error }, r.error === 'not_found' ? 404 : 409)
      } catch { return json({ ok: false, error: 'unavailable' }, 503) }
    }),
    // 对终端会话接着说一句 —— 与微信「@码」同一个 core;收下即回,结果成为这条会话的下一句。
    'POST /m/api/cli/say': ownsMethod(async (url: URL, req: Request) => {
      if (req.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405)
      if (!deps.cliActions) return json({ ok: false, error: 'cli_actions_not_wired' }, 503)
      const b = await bodyOf(req)
      const sessionId = b?.['session_id'], text = typeof b?.['text'] === 'string' ? (b['text'] as string).trim() : ''
      if (!b || typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId) || !text || text.length > PHONE_CLI_SAY_MAX || text.includes('\0')) return json({ ok: false, error: 'invalid' }, 400)
      try {
        const r = deps.cliActions.say(sessionId, text)
        if (r.ok) return json({ ok: true, accepted: true, ...(r.say_id ? { say_id: r.say_id } : {}) })
        return json({ ok: false, error: r.error }, r.error === 'not_found' ? 404 : 409)
      } catch { return json({ ok: false, error: 'unavailable' }, 503) }
    }),
  }
}
