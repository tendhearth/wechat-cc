/**
 * internal-api 故障记录路由(Task 8, spec 2026-08-03-connection-health §8)。
 * 桌面靠这条路由读"上次故障"——2026-08-02 那次静默 10.5 小时的教训,主人
 * 只有翻日志才发现。undefined incidents(未接线)⇒ 空列表而不是 503:
 * "没有故障记录"是正常状态,不是错误,不该让整页因此判"未启用"。
 */
import type { InternalApiDeps, RouteTable } from './types'

export function healthRoutes(deps: InternalApiDeps): RouteTable {
  return {
    'GET /v1/health/incidents': async () => {
      return { status: 200, body: { incidents: deps.incidents?.list() ?? [] } }
    },
  }
}
