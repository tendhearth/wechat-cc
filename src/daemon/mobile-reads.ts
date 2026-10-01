import { redactConnections, type ConnectionsSnapshot } from './connections'

/**
 * mobile-reads.ts — 手机只读路由(spec 2026-10-01 §3):CC 的连接、电脑上的原生会话。
 * 路由字面量被 scripts/phone-routes.guard.test.ts 扫描。纵深防御:连接经 redactConnections,
 * 手机口径永远没有插件目录与未就绪原因(设备/链接令牌本身也是 admin 档)。
 */
export interface MobileReadsDeps { connections?: () => ConnectionsSnapshot }
const json = (body: object, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

export async function mobileReadsRoute(deps: MobileReadsDeps, url: URL, req: Request, _opts: { budgetMs?: number } = {}): Promise<Response | null> {
  if (url.pathname === '/m/api/connections') {
    if (req.method !== 'GET') return json({ ok: false, error: 'method_not_allowed' }, 405)
    if (!deps.connections) return json({ ok: false, error: 'connections_not_wired' }, 503)
    // 裁定 7:内部失败一律 503(客户端当作离线/不可用),不是 500。
    try { return json({ ok: true, ...redactConnections(deps.connections()) }) }
    catch { return json({ ok: false, error: 'unavailable' }, 503) }
  }
  return null
}
