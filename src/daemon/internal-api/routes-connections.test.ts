import { describe, expect, it } from 'vitest'
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
