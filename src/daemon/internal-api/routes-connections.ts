import type { InternalApiDeps, RouteTable } from './types'

/** 「CC 的连接」全量快照(admin:带插件目录与未就绪原因)。手机走 /m/api/connections(去掉 detail)。 */
export function connectionsRoutes(deps: InternalApiDeps): RouteTable {
  return {
    'GET /v1/connections': async () => {
      if (!deps.connections) return { status: 503, body: { error: 'connections_not_wired' } }
      // 裁定 7:内部失败 503,不是 500。
      try { return { status: 200, body: deps.connections() } } catch { return { status: 503, body: { error: 'unavailable' } } }
    },
  }
}
