import { CLI_SPECS } from '../../domain/cli-upgrade/specs'
import type { UsageMonitor } from '../../domain/subscription-usage'
import { redactConnections } from '../connections'
import type { InternalApiDeps, RouteHandler, RouteTable } from './types'

/** 手机设置面板那一口的令牌(设备 / 链接)。 */
const fromPhone = (caller: Parameters<RouteHandler>[2]): boolean => caller?.origin === 'device' || caller?.origin === 'link'

const USAGE_PROVIDERS = ['claude', 'codex'] as const

async function readUsage(monitor: Pick<UsageMonitor, 'get' | 'peek'>, refresh: boolean) {
  if (refresh) {
    // 额度读慢时，先交还连接快照。已有的状态刷新会捎回随后写入的缓存。
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<void>(resolve => { timer = setTimeout(resolve, 2_000) })
    try {
      await Promise.race([Promise.allSettled(USAGE_PROVIDERS.map(async id => monitor.get(id))), deadline])
    } finally {
      clearTimeout(timer)
    }
  }
  return USAGE_PROVIDERS.flatMap(providerId => {
    const windows = monitor.peek(providerId)?.windows
    return windows?.length ? [{
      providerId,
      displayName: CLI_SPECS[providerId].label,
      windows: windows.map(({ usedPercent, resetsAt, durationMins }) => ({ usedPercent, resetsAt, durationMins })),
    }] : []
  })
}

/**
 * 「CC 的连接」快照。operator(桌面 / CLI)拿全量:带插件目录与未就绪原因(detail)。
 * 手机令牌(P3c-2,原 /m/api/connections 的处理器)拿去掉 detail 的那一份(redactConnections)—— 规矩随令牌走,不随路径走。
 */
export function connectionsRoutes(deps: InternalApiDeps): RouteTable {
  return {
    'GET /v1/connections': async (q, _body, caller) => {
      if (!deps.connections) return { status: 503, body: { error: 'connections_not_wired' } }
      // 裁定 7:内部失败 503,不是 500。
      try {
        const snap = deps.connections()
        const base = fromPhone(caller) ? redactConnections(snap) : snap
        const canReadUsage = caller?.tier === 'admin' && (caller.origin === 'operator' || caller.origin === 'device')
        if (!canReadUsage || !deps.connectionUsage) return { status: 200, body: base }
        let subscriptionUsage: Awaited<ReturnType<typeof readUsage>> = []
        try { subscriptionUsage = await readUsage(deps.connectionUsage, q.get('usage') === 'refresh') } catch { /* 额度读不到就省略 */ }
        return { status: 200, body: subscriptionUsage.length ? { ...base, subscriptionUsage } : base }
      } catch { return { status: 503, body: { error: 'unavailable' } } }
    },
  }
}
