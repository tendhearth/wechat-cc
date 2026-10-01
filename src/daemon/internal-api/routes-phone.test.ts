import { describe, expect, it, vi } from 'vitest'
import { phoneRoutes } from './routes-phone'
import { minTierFor } from './route-tiers'
import type { InternalApiDeps } from './types'

const q = new URLSearchParams()
const DEV = { id: 'aa11bb22', created_at: '2026-10-01T00:00:00.000Z', last_seen_at: '2026-10-01T00:00:00.000Z', label: 'Tendhearth · iPhone' }

describe('POST /v1/phone/link · GET /v1/phone/devices(spec §4.1)', () => {
  it('两条都是 admin', () => {
    expect(minTierFor('POST /v1/phone/link')).toBe('admin')
    expect(minTierFor('GET /v1/phone/devices')).toBe('admin')
  })
  it('link:enable_remote 透传(缺省 false);类型不对 400;没接 503;抛 503', async () => {
    const link = vi.fn(async () => ({ ok: false as const, state: 'starting' as const }))
    const r = phoneRoutes({ phoneConnect: { link, devices: () => [] } } as unknown as InternalApiDeps)
    expect(await r['POST /v1/phone/link']!(q, { enable_remote: true })).toEqual({ status: 200, body: { ok: false, state: 'starting' } })
    expect(link).toHaveBeenLastCalledWith({ enableRemote: true })
    await r['POST /v1/phone/link']!(q, undefined)
    expect(link).toHaveBeenLastCalledWith({ enableRemote: false })
    expect((await r['POST /v1/phone/link']!(q, { enable_remote: 'yes' })).status).toBe(400)
    expect((await phoneRoutes({} as InternalApiDeps)['POST /v1/phone/link']!(q, {})).status).toBe(503)
    const boom = phoneRoutes({ phoneConnect: { link: async () => { throw new Error('x') }, devices: () => [] } } as unknown as InternalApiDeps)
    expect(await boom['POST /v1/phone/link']!(q, {})).toEqual({ status: 503, body: { error: 'unavailable' } })
  })
  it('M2:抛错时记日志(不带令牌),仍回 503', async () => {
    const log = vi.fn()
    const r = phoneRoutes({ log, phoneConnect: { link: async () => { throw new Error('boom tabc') }, devices: () => { throw new Error('boom2') } } } as unknown as InternalApiDeps)
    expect((await r['POST /v1/phone/link']!(q, {})).status).toBe(503)
    expect((await r['GET /v1/phone/devices']!(q, undefined)).status).toBe(503)
    expect(log).toHaveBeenCalledTimes(2)
    expect(log.mock.calls.every(c => c[0] === 'INTERNAL_API')).toBe(true)
  })
  it('devices:列表原样;没接 503', async () => {
    const r = phoneRoutes({ phoneConnect: { link: vi.fn(), devices: () => [DEV] } } as unknown as InternalApiDeps)
    expect(await r['GET /v1/phone/devices']!(q, undefined)).toEqual({ status: 200, body: { ok: true, devices: [DEV] } })
    expect((await phoneRoutes({} as InternalApiDeps)['GET /v1/phone/devices']!(q, undefined)).status).toBe(503)
  })
})
