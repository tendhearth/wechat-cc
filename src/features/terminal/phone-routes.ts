import { PHONE_FRAME_BUDGET_BYTES, framedTooLargeFor } from '../../domain/matters/phone-scope'
import { ownsMethod, type PhoneRouteTable } from '../../lib/phone-route-table'
import { PHONE_CLI_SAY_MAX, type CliPhoneActions } from './phone-actions'

/**
 * phone-routes.ts — 手机上的终端会话三条(spec 2026-10-01 §3;P3d-3 从 `features/phone/mobile-reads.ts` 搬回终端这个功能):
 * 看着它跑、拍板、接着说一句。表经 index.ts 导出,组装的地方(`wiring/wire-settings-panel.ts`)交给面板的 `featureRoutes`
 * —— 面板不 import 别的功能。表里的键由 scripts/phone-routes.guard.test.ts 对着路由表核对。
 *
 * 键是手机独有的 `/v1` 行(只有 phone 块,处理器在面板这一口):`GET /v1/cli/activity`、`POST /v1/cli/decide`、
 * `POST /v1/cli/session-say`。后两条起了不撞的名字 —— `/v1/cli/permission` 是钩子登记 / 等答案(CLI 子进程,trusted),
 * `/v1/cli/say` 是 CC 的 terminal_say(只认主人会话,按「码」、回票再等);这里按 `session_id` / 中继开的码、收下即回。
 * 老 App 的 `/m/api/cli/*` 是 legacy-routes.ts 的纯改名别名,回包一字不变。
 */
export interface TerminalPhoneRoutesDeps {
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
  while (max > 64 && framedTooLargeFor(body, PHONE_FRAME_BUDGET_BYTES)) { max = Math.floor(max / 2); body = JSON.stringify(build(max)) }
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}

export function terminalPhoneRoutes(deps: TerminalPhoneRoutesDeps): PhoneRouteTable {
  return {
    // 看着它跑(2026-10-17):一条终端会话最近几步。手机展开那一行时每几秒拉一次;只读,和「看 码」同一份记录。
    'GET /v1/cli/activity': ownsMethod(async (url: URL, req: Request) => {
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
    'POST /v1/cli/decide': ownsMethod(async (url: URL, req: Request) => {
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
    'POST /v1/cli/session-say': ownsMethod(async (url: URL, req: Request) => {
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
