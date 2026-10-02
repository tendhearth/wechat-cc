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
  it('renders the network guard block (2026-10-02) and omits it when unwired; validates against HealthResponse', async () => {
    const { HealthResponse } = await import('./schema')
    const guard = { enabled: true, source: 'bx' as const, safe: false, detail: 'bx 未保护(protection_state=off)', ip: '1.2.3.4', checked_at: '2026-10-02T10:00:00.000Z',
      // 守护 v2:按调用判的字段
      signal_source: 'auto' as const, protected_in_use: true, paused: true,
      providers: [{ id: 'claude', model: null, host: 'api.anthropic.com', protected: true, kind: 'official', label: 'Claude', reason: '官方端点' }] }
    const r = await makeRoutesUnderTest({ guard: () => guard })['GET /v1/health']!({} as any, undefined)
    expect((r.body as any).guard).toEqual(guard)
    expect(HealthResponse.safeParse(r.body).success).toBe(true)
    const r2 = await makeRoutesUnderTest({})['GET /v1/health']!({} as any, undefined)
    expect((r2.body as any).guard).toBeUndefined()
  })

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

  it('GET /v1/health renders the plugins snapshot per tier (null while bootstrap is still wiring) and omits it when unwired', async () => {
    const snap = {
      bundled_dir: '/Users/owner/plugins', via: 'pointer' as const, pointer_dir: '/Users/owner/plugins', pointer_broken: false,
      plugins: [{ name: 'wxvault', source: 'bundled' as const, enabled: true, ready: false, reason: 'missing /Users/owner/x' }],
      expected_missing: ['wxsearch'],
    }
    const routes = makeRoutesUnderTest({ plugins: () => snap })
    // guest / trusted (the file token self deploy uses): counts + names only
    const trusted = await routes['GET /v1/health']!({} as any, undefined, { tier: 'trusted', origin: 'file' } as any)
    expect((trusted.body as any).plugins).toEqual({ via: 'pointer', count: 1, ready_count: 0, expected_missing: ['wxsearch'], pointer_broken: false })
    expect(JSON.stringify((trusted.body as any).plugins)).not.toContain('/Users/owner')
    const anon = await routes['GET /v1/health']!({} as any, undefined)
    expect((anon.body as any).plugins.bundled_dir).toBeUndefined()
    // admin keeps the detail
    const admin = await routes['GET /v1/health']!({} as any, undefined, { tier: 'admin', origin: 'operator' } as any)
    expect((admin.body as any).plugins.bundled_dir).toBe('/Users/owner/plugins')
    expect((admin.body as any).plugins.plugins[0].reason).toContain('/Users/owner/x')
    const wiring = await makeRoutesUnderTest({ plugins: () => null })['GET /v1/health']!({} as any, undefined)
    expect((wiring.body as any).plugins).toBeNull()
    const without = await makeRoutesUnderTest({})['GET /v1/health']!({} as any, undefined)
    expect('plugins' in (without.body as any)).toBe(false)
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
