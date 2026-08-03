import { describe, it, expect } from 'vitest'
import { healthRoutes } from './routes-health'
import type { InternalApiDeps } from './types'

const q = (s = '') => new URLSearchParams(s)

const SAMPLE_INCIDENT = {
  id: 'i1',
  dependency: 'wechat',
  kind: 'network',
  actionable: false,
  startedAt: '2026-08-02T14:33:00.000Z',
  endedAt: '2026-08-03T01:08:00.000Z',
  notifiedAt: '2026-08-02T14:48:00.000Z',
  lastError: null,
}

describe('GET /v1/health/incidents', () => {
  it('返回故障列表', async () => {
    const deps = { incidents: { list: () => [SAMPLE_INCIDENT] } } as unknown as InternalApiDeps
    const r = await healthRoutes(deps)['GET /v1/health/incidents']!(q(), undefined)
    expect(r.status).toBe(200)
    expect(r.body).toEqual({
      incidents: [expect.objectContaining({ dependency: 'wechat', endedAt: '2026-08-03T01:08:00.000Z' })],
    })
  })

  it('未接线时返回空列表而不是 503 —— 没有故障记录是正常状态', async () => {
    const deps = { incidents: undefined } as unknown as InternalApiDeps
    const r = await healthRoutes(deps)['GET /v1/health/incidents']!(q(), undefined)
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ incidents: [] })
  })
})
