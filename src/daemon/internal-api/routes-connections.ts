import { redactConnections } from '../connections'
import type { InternalApiDeps, RouteHandler, RouteTable } from './types'

/** 手机设置面板那一口的令牌(设备 / 链接)。 */
const fromPhone = (caller: Parameters<RouteHandler>[2]): boolean => caller?.origin === 'device' || caller?.origin === 'link'

/**
 * 「CC 的连接」快照。operator(桌面 / CLI)拿全量:带插件目录与未就绪原因(detail)。
 * 手机令牌(P3c-2,原 /m/api/connections 的处理器)拿去掉 detail 的那一份(redactConnections)—— 规矩随令牌走,不随路径走。
 */
export function connectionsRoutes(deps: InternalApiDeps): RouteTable {
  return {
    'GET /v1/connections': async (_q, _body, caller) => {
      if (!deps.connections) return { status: 503, body: { error: 'connections_not_wired' } }
      // 裁定 7:内部失败 503,不是 500。
      try {
        const snap = deps.connections()
        return { status: 200, body: fromPhone(caller) ? redactConnections(snap) : snap }
      } catch { return { status: 503, body: { error: 'unavailable' } } }
    },
  }
}
