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

describe('GET /v1/health · version', () => {
  it('接了 version 时报出来:桌面更新后 app 才看得出后台还是不是旧的', async () => {
    const routes = makeRoutesUnderTest({ version: () => ({ cli: '1.6.7', head: 'abc1234', boot_at: '2026-09-16T07:00:00.000Z' }) })
    const r = await routes['GET /v1/health']!(q(), undefined)
    expect(r.status).toBe(200)
    expect((r.body as { version?: unknown }).version).toEqual({ cli: '1.6.7', head: 'abc1234', boot_at: '2026-09-16T07:00:00.000Z' })
  })
  it('没接 version 的最小依赖路径照旧,不带这个字段', async () => {
    const routes = makeRoutesUnderTest({})
    const r = await routes['GET /v1/health']!(q(), undefined)
    expect(r.status).toBe(200)
    expect('version' in (r.body as object)).toBe(false)
  })
})
