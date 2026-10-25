/**
 * mobile-activity.ts — 手机上的「CC 做过的事」(B9,spec 2026-10-20-cc-activity-design)。表里的键由
 * scripts/phone-routes.guard.test.ts 对着路由表核对,新增 / 改名要同步 routes.ts 与 PHONE_API_SCHEMAS。
 *
 * - GET /m/api/activity?cursor=&limit=:新的在前,一页默认 30、最多 100;窗口 14 天;坏掉的来源列在 degraded。
 *
 * 只给设备令牌(不在链接白名单 LINK_READ_OK / LINK_WRITE_OK 里):里面有主动说话、定时标题、提醒原文这类主人的私事。只读,不进日志。
 */
import { buildActivity, type ActivitySources } from '../core/cc-activity'
import { ownsMethod, type PhoneRouteTable } from './phone-route-table'

export interface MobileActivityDeps {
  sources(): ActivitySources
  now(): number
}

const json = (body: object, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

const activity = (deps: MobileActivityDeps | undefined) => async (url: URL, req: Request): Promise<Response> => {
  if (req.method !== 'GET') return json({ ok: false, error: 'method_not_allowed' }, 405)
  if (!deps) return json({ ok: false, error: 'activity_not_wired' }, 503)
  const limitRaw = Number(url.searchParams.get('limit'))
  try {
    const r = buildActivity(deps.sources(), { now: deps.now(), cursor: url.searchParams.get('cursor'), ...(Number.isFinite(limitRaw) && limitRaw > 0 ? { limit: limitRaw } : {}) })
    return json({ ok: true, items: r.items, next: r.next, degraded: r.degraded })
  } catch { return json({ ok: false, error: 'unavailable' }, 500) }
}

export function mobileActivityRoutes(deps: MobileActivityDeps | undefined): PhoneRouteTable {
  return { 'GET /m/api/activity': ownsMethod(activity(deps)) }
}
