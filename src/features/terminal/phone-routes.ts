import { PHONE_FRAME_BUDGET_BYTES, framedTooLargeFor } from '../../domain/matters/phone-scope'
import { ownsMethod, type PhoneHandler } from '../../lib/phone-route-table'
import { PHONE_CLI_SAY_MAX, type CliPhoneActions } from './phone-actions'

/**
 * 主人终端操作的共享 HTTP 处理器，由 terminal/routes.ts 接到同一条 /v1 路由。
 * operator 与配对设备沿用同一套拍板码、会话恢复与运行轮次校验；旧 /m/api 地址只做改名。
 * /v1/cli/permission 仍是 CLI 钩子的登记 / 等答案口，不与这里的主人决定口混用。
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

export function terminalOwnerHandlers(deps: TerminalPhoneRoutesDeps): Record<string,PhoneHandler> {
  return {
    'POST /v1/cli/session-stop': ownsMethod(async(_url,req)=>{
      if(req.method!=='POST')return json({ok:false,error:'method_not_allowed'},405)
      const b=await bodyOf(req)
      if(typeof b?.session_id!=='string'||!SESSION_ID_RE.test(b.session_id)||typeof b.run_id!=='string'||b.run_id.length>128||b.confirmed!==true)return json({ok:false,error:'invalid'},400)
      return deps.cliActions?.stop?.(b.session_id,b.run_id)?json({ok:true}):json({ok:false,error:'input_stale'},409)
    }),
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
