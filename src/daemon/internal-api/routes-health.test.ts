import { describe, it, expect } from 'vitest'
import { healthRoutes } from './routes-health'
import { makeRoutes } from './routes'
import type { InternalApiDeps } from './types'

const q = (s = '') => new URLSearchParams(s)

function makeRoutesUnderTest(deps: Partial<InternalApiDeps>) {
  const fullDeps = {
    daemonPid: 12345,
    ...deps,
  } as InternalApiDeps
  return makeRoutes({
    deps: fullDeps,
    getDelegate: () => null,
    maybePrefix: () => '',
  })
}

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

describe('GET /v1/health', () => {
  it('GET /v1/health renders outbound from the dep and omits it when unwired', async () => {
    const withDep = makeRoutesUnderTest({ outbound: () => ({
      state: 'degraded', consecutiveFailures: 2, lastOkAt: null,
      lastFailAt: '2026-08-22T10:01:00.000Z', lastError: 'boom', episodeStartedAt: '2026-08-22T10:00:00.000Z',
    }) })
    const r = await withDep['GET /v1/health']!({} as any, undefined)
    expect((r.body as any).outbound).toEqual({
      state: 'degraded', consecutive_failures: 2, last_ok_at: null, last_error: 'boom',
    })
    const without = makeRoutesUnderTest({})
    const r2 = await without['GET /v1/health']!({} as any, undefined)
    expect((r2.body as any).outbound).toBeUndefined()
  })
})

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
