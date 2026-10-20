/**
 * mobile-jobs.ts — 手机上的定时列表(对标 B7)。路由字面量被 scripts/phone-routes.guard.test.ts 扫描,
 * 新增 / 改名要同步 PHONE_ROUTES 与 PHONE_API_SCHEMAS。
 *
 * - GET /m/api/jobs:定时列表(时间带时区、早报标记、停着没、上次结果)+ 定时用哪个执行者。
 * - POST /m/api/jobs/action:正文恰好 { id, action: pause | resume | remove }。
 *
 * 只给设备令牌(配过对的主人手机);/set 链接令牌不在册 —— 定时的正文是主人的私事,停删也不该被泄露的链接做掉。
 * 新建定时仍在微信「定时」里说(手机上先只看与停删)。正文不进日志。
 */
import type { JobsActionKind, JobsView } from './scheduled-jobs/view'

export interface MobileJobsDeps {
  view(): JobsView
  action(id: string, action: JobsActionKind): { ok: true } | { ok: false; error: 'not_found' }
}

const json = (body: object, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const err = (error: string, status: number) => json({ ok: false, error }, status)
const ACTIONS: readonly JobsActionKind[] = ['pause', 'resume', 'remove']

export async function mobileJobsRoute(deps: MobileJobsDeps | undefined, url: URL, req: Request): Promise<Response | null> {
  if (url.pathname === '/m/api/jobs') {
    if (req.method !== 'GET') return err('method_not_allowed', 405)
    if (!deps) return err('jobs_not_wired', 503)
    let v: JobsView
    try { v = deps.view() } catch { return err('unavailable', 500) }
    return v.ok ? json(v) : err(v.error, 500)
  }
  if (url.pathname === '/m/api/jobs/action') {
    if (req.method !== 'POST') return err('method_not_allowed', 405)
    if (!deps) return err('jobs_not_wired', 503)
    let b: unknown
    try { b = await req.json() } catch { return err('invalid', 400) }
    const o = b as { id?: unknown; action?: unknown } | null
    if (!o || typeof o !== 'object' || Array.isArray(o) || Object.keys(o).some(k => k !== 'id' && k !== 'action')
      || typeof o.id !== 'string' || !/^j\d{1,6}$/.test(o.id) || !ACTIONS.includes(o.action as JobsActionKind)) return err('invalid', 400)
    try {
      const r = deps.action(o.id, o.action as JobsActionKind)
      return r.ok ? json({ ok: true }) : err(r.error, 404)
    } catch { return err('unavailable', 500) }
  }
  return null
}
