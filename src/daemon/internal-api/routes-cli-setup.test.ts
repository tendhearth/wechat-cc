import { describe, expect, it, vi } from 'vitest'
import { makeRoutes } from './routes'
import type { InternalApiDeps } from './types'
import * as setup from '../cli-setup'

function fixture(allowed = true) {
  const check = vi.fn(async () => ({ safe: allowed, source: 'bx' as const, detail: '' }))
  const service = setup.makeCliSetup({ stateDir: '/tmp/isolated-setup', platform: 'darwin', binary: () => null,
    guard: () => ({ enabled: true, safe: allowed, source: 'bx' }), checkGuard: check })
  const routes = makeRoutes({ deps: { cliSetup: service } as unknown as InternalApiDeps, getDelegate: () => null, maybePrefix: () => '' })
  return { routes, check }
}
const owner = { tier: 'admin', origin: 'operator' } as const
const q = new URLSearchParams()

describe('desktop CLI setup routes', () => {
  it('returns daemon-owned metadata and fails closed without safe bx', async () => {
    const { routes } = fixture(false)
    const r = await routes['GET /v1/llm/setup']!(q, undefined, owner as never)
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ allowed: false, blockedReason: '网络保护没开,先打开 bx 再装' })
    expect((r.body as any).providers.map((p: any) => p.id)).toEqual(['claude', 'codex', 'cursor', 'agy', 'grok'])
  })
  it('rechecks guard before returning a script and rejects extra command input', async () => {
    const { routes, check } = fixture()
    const post = routes['POST /v1/llm/setup']!
    expect((await post(q, { provider: 'claude', action: 'install', command: 'touch /tmp/pwn' }, owner as never)).status).toBe(400)
    expect(check).not.toHaveBeenCalled()
    const r = await post(q, { provider: 'claude', action: 'install' }, owner as never)
    expect(r.status).toBe(200)
    expect((r.body as any).script).toContain('claude auth login')
    expect(check).toHaveBeenCalledTimes(1)
  })
  it('forbids remote/session callers and blocks unsafe launch', async () => {
    const { routes } = fixture(false)
    const post = routes['POST /v1/llm/setup']!
    expect((await post(q, { provider: 'grok', action: 'install' }, { tier: 'admin', origin: 'session' } as never)).status).toBe(403)
    expect((await post(q, { provider: 'grok', action: 'install' }, owner as never)).status).toBe(409)
  })
  it.each(['off', 'probe'] as const)('does not treat safe:%s as protected bx', async source => {
    const service = setup.makeCliSetup({ stateDir: '/tmp/test', platform: 'darwin', binary: () => null,
      guard: () => ({ enabled: true, safe: true, source }), checkGuard: async () => ({ safe: true, source, detail: '' }) })
    expect(service.snapshot().allowed).toBe(false)
    await expect(service.plan({ provider: 'codex', action: 'install' })).rejects.toThrow('network_unprotected')
  })
})

it('scopes existing health to the requested provider and refreshes installation before dialing', async () => {
  const events: string[] = []
  const service = setup.makeCliSetup({ stateDir: '/tmp/test', platform: 'darwin', binary: () => '/fixture/cli',
    guard: () => ({ enabled: true, safe: true, source: 'bx' }), checkGuard: async () => ({ safe: true, source: 'bx', detail: '' }), grokLoggedIn: () => true, beginLogin: () => ({ command: 'fixture', completed: () => true, dispose() {} }) })
  await service.plan({ provider: 'grok', action: 'login' })
  const routes = makeRoutes({ deps: { cliSetup: service,
    llmRefreshProvider: async id => { events.push('register:' + id); return true },
    llmRegistered: () => ['claude', 'grok'],
    llmHealth: { cached: () => null, dial: async scope => { events.push('dial:' + scope); return { checked_at: 'now', default_provider: 'claude', results: [] } } },
  } as Partial<InternalApiDeps> as InternalApiDeps, getDelegate: () => null, maybePrefix: () => '' })
  const health = routes['GET /v1/llm/health']!
  await health(new URLSearchParams('fresh=1&provider=claude'), undefined, owner as never)
  expect(events).toEqual(['register:claude', 'dial:claude'])
  events.length = 0
  const r = await health(new URLSearchParams('fresh=1&provider=grok'), undefined, owner as never)
  expect(events).toEqual(['register:grok'])
  expect((r.body as any).results[0]).toMatchObject({ provider: 'grok', ok: true, source: 'login_receipt' })
  expect((await health(new URLSearchParams('fresh=1&provider=grok%3Bwhoami'), undefined, owner as never)).status).toBe(400)
})

it('never treats a stale Grok auth file as a successful current login', async () => {
  const service = setup.makeCliSetup({ stateDir: '/tmp/test', platform: 'darwin', binary: () => '/fixture/grok', grokLoggedIn: () => true,
    guard: () => ({ enabled: true, safe: true, source: 'bx' }), checkGuard: async () => ({ safe: true, source: 'bx', detail: '' }) })
  const routes = makeRoutes({ deps: { cliSetup: service, llmRegistered: () => ['grok'], llmRefreshProvider: async () => true,
    llmHealth: { cached: () => null, dial: async () => { throw new Error('must not dial Grok') } },
  } as Partial<InternalApiDeps> as InternalApiDeps, getDelegate: () => null, maybePrefix: () => '' })
  const r = await routes['GET /v1/llm/health']!(new URLSearchParams('fresh=1&provider=grok'), undefined, owner as never)
  expect((r.body as any).results[0].ok).toBe(false)
})

it('explains an existing Windows executor limit while retaining its official installer', () => {
  const service = setup.makeCliSetup({ stateDir: '/tmp/test', platform: 'win32', binary: () => null, supported: id => id !== 'grok',
    guard: () => ({ enabled: true, safe: true, source: 'bx' }), checkGuard: async () => ({ safe: true, source: 'bx', detail: '' }) })
  const grok = service.snapshot().providers.find(p => p.id === 'grok')!
  expect(grok.canInstall).toBe(true)
  expect(grok.runtimeSupported).toBe(false)
  expect(grok.supportNote).toContain('Windows')
})
it('does not let a trusted chat session trigger desktop installation refresh', async () => {
  const refresh = vi.fn(async () => true)
  const cliSetup = setup.makeCliSetup({ stateDir: '/tmp/test', platform: 'darwin', binary: () => null, guard: () => ({ enabled: true, safe: true, source: 'bx' }), checkGuard: async () => ({ safe: true, source: 'bx', detail: '' }) })
  const routes = makeRoutes({ deps: { cliSetup, llmHealth: { cached: () => null, dial: vi.fn() }, llmRefreshProvider: refresh } as unknown as InternalApiDeps,
    getDelegate: () => null, maybePrefix: () => '' })
  const r = await routes['GET /v1/llm/health']!(new URLSearchParams('fresh=1&provider=grok'), undefined, { tier: 'trusted', origin: 'session' } as never)
  expect(r.status).toBe(403)
  expect(refresh).not.toHaveBeenCalled()
})
it('keeps unsupported desktop platforms readable and offers the website without a launch button', () => {
  const service = setup.makeCliSetup({ stateDir: '/tmp/test', platform: 'linux', binary: () => '/fixture/installed',
    guard: () => ({ enabled: true, safe: true, source: 'bx' }), checkGuard: async () => ({ safe: true, source: 'bx', detail: '' }) })
  const p = service.snapshot().providers[0]!
  expect(p.website).toBe('https://claude.com/claude-code')
  expect(p.canInstall).toBe(false)
  expect(p.canLogin).toBe(false)
})
