import { describe, expect, it, vi } from 'vitest'
import { makeUsageMonitor, parseClaudeUsage, parseCodexRateLimits, type UsageSnapshot } from '../../domain/subscription-usage'
import { connectionsRoutes } from './routes-connections'
import { minTierFor } from './route-tiers'
import type { InternalApiDeps } from './types'

describe('GET /v1/connections', () => {
  it('admin 档;带 detail 的全量;没接 503;抛 503(裁定 7)', async () => {
    expect(minTierFor('GET /v1/connections')).toBe('admin')
    const snap = { generatedAt: 1, sources: [{ id: 'wechat_history', detail: { dir: '/x' } }], computers: [], recent: [], outputs: [] }
    const r = await connectionsRoutes({ connections: () => snap } as unknown as InternalApiDeps)['GET /v1/connections']!(new URLSearchParams(), undefined)
    expect(r).toEqual({ status: 200, body: snap })
    expect((await connectionsRoutes({} as InternalApiDeps)['GET /v1/connections']!(new URLSearchParams(), undefined)).status).toBe(503)
    const thrown = await connectionsRoutes({ connections: () => { throw new Error('x') } } as unknown as InternalApiDeps)['GET /v1/connections']!(new URLSearchParams(), undefined)
    expect(thrown.status).toBe(503)
  })
})

describe('订阅额度字段', () => {
  const snap = { generatedAt: 1, sources: [{ id: 'wechat_history', kind: 'wechat_history', name: '微信', state: 'ready', latestAt: null, syncedAt: null, detail: { dir: '/fixture' } }], computers: [], recent: [], outputs: [] } as const
  const refresh = new URLSearchParams('usage=refresh')
  const base = { connections: () => snap } as unknown as InternalApiDeps

  it('设备按打开请求刷新，后续状态读取只用缓存，输出不含账号信息', async () => {
    const claude = vi.fn(async () => parseClaudeUsage({ five_hour: { utilization: 40 } }, 1, 'max'))
    const monitor = makeUsageMonitor({ sources: { claude }, now: () => 1 })
    const route = connectionsRoutes({ ...base, connectionUsage: monitor })['GET /v1/connections']!
    const device = { tier: 'admin', origin: 'device' } as const
    const ordinary = new URLSearchParams()
    expect((await route(ordinary, undefined, device)).body).not.toHaveProperty('subscriptionUsage')
    expect(claude).not.toHaveBeenCalled()
    const opened = await route(refresh, undefined, device)
    expect(opened).toEqual({ status: 200, body: { ...snap,
      sources: [{ id: 'wechat_history', kind: 'wechat_history', name: '微信', state: 'ready', latestAt: null, syncedAt: null }],
      subscriptionUsage: [{ providerId: 'claude', displayName: 'Claude Code', windows: [{ usedPercent: 40, resetsAt: null, durationMins: 300 }] }],
    } })
    expect(await route(ordinary, undefined, device)).toEqual(opened)
    expect(claude).toHaveBeenCalledTimes(1)
    for (const origin of ['link', 'session'] as const) {
      expect((await route(refresh, undefined, { tier: 'admin', origin })).body).not.toHaveProperty('subscriptionUsage')
    }
    expect((await route(refresh, undefined, { tier: 'trusted', origin: 'device' })).body).not.toHaveProperty('subscriptionUsage')
    expect(claude).toHaveBeenCalledTimes(1)
  })

  it('一个来源响应慢，桌面先拿到另一个来源的额度，下一次状态读取捎回缓存', async () => {
    vi.useFakeTimers()
    try {
      let finish!: (value: UsageSnapshot) => void
      const monitor = makeUsageMonitor({ sources: {
        claude: async () => parseClaudeUsage({ five_hour: { utilization: 40 } }, 1, null),
        codex: () => new Promise(resolve => { finish = resolve }),
      } })
      const route = connectionsRoutes({ ...base, connectionUsage: monitor })['GET /v1/connections']!
      const desktop = { tier: 'admin', origin: 'operator' } as const
      const opened = route(refresh, undefined, desktop)
      await vi.advanceTimersByTimeAsync(2_000)
      expect(await opened).toMatchObject({ status: 200, body: { subscriptionUsage: [{ providerId: 'claude' }] } })
      finish(parseCodexRateLimits({ rateLimits: { primary: { usedPercent: 80 } } }, 1))
      await monitor.get('codex')
      expect(await route(new URLSearchParams(), undefined, desktop)).toMatchObject({
        status: 200, body: { subscriptionUsage: [{ providerId: 'claude' }, { providerId: 'codex' }] },
      })
    } finally { vi.useRealTimers() }
  })
})
