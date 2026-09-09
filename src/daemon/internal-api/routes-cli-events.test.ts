import { describe, it, expect, vi } from 'vitest'
import { cliEventRoutes, CLI_PERMISSION_POLL_CAP_MS } from './routes-cli-events'
import { minTierFor } from './route-tiers'
import { REQUEST_SCHEMAS } from './schema'
import type { InternalApiDeps } from './types'

const qs = () => new URLSearchParams()
const deps = (cliEvents?: InternalApiDeps['cliEvents'], cliPermissions?: InternalApiDeps['cliPermissions']): InternalApiDeps => ({ cliEvents, cliPermissions } as unknown as InternalApiDeps)
const body = { source: 'claude', kind: 'stop', session_id: 'abc123', cwd: '/w/p', text: 'done' }

describe('POST /v1/cli/event(spec 2026-09-09-cli-hook-push §6.1)', () => {
  it('没接线 → 503;接了 → 转给 hub.ingest,回 action', async () => {
    const off = cliEventRoutes(deps())['POST /v1/cli/event']!
    expect(await off(qs(), body)).toEqual({ status: 503, body: { error: 'cli_events_not_wired' } })
    const ingest = vi.fn(() => 'scheduled' as const)
    const on = cliEventRoutes(deps({ ingest }))['POST /v1/cli/event']!
    expect(await on(qs(), body)).toEqual({ status: 200, body: { ok: true, action: 'scheduled' } })
    expect(ingest).toHaveBeenCalledWith(body)
  })

  it('schema:source / kind 只认枚举;session_id、cwd 必填;text 可省', () => {
    const s = REQUEST_SCHEMAS['POST /v1/cli/event']!
    expect(s.safeParse(body).success).toBe(true)
    expect(s.safeParse({ ...body, text: undefined }).success).toBe(true)
    expect(s.safeParse({ ...body, kind: 'prompt', automated: true }).success).toBe(true)
    expect(s.safeParse({ ...body, source: 'cursor' }).success).toBe(false)
    expect(s.safeParse({ ...body, kind: 'idle' }).success).toBe(false)
    expect(s.safeParse({ ...body, session_id: '' }).success).toBe(false)
    expect(s.safeParse({ ...body, cwd: '' }).success).toBe(false)
    expect(s.safeParse({ ...body, text: 'x'.repeat(4001) }).success).toBe(false)
  })

  it('tier 是 trusted(hook 拿的是 FILE token)', () => {
    expect(minTierFor('POST /v1/cli/event')).toBe('trusted')
  })
})

describe('/v1/cli/permission(spec §6.3)', () => {
  const preq = { source: 'codex', session_id: 'abc123', cwd: '/w/p', tool_name: 'Bash', summary: 'rm -rf ./tmp' }
  it('没接线 → 503;POST → relay.open;GET 不带 wait → status;带 wait → wait(封顶 25s)', async () => {
    const off = cliEventRoutes(deps())
    expect(await off['POST /v1/cli/permission']!(qs(), preq)).toEqual({ status: 503, body: { error: 'cli_permissions_not_wired' } })
    const open = vi.fn(() => ({ status: 'pending' as const, hash: 'k3x9z' }))
    const status = vi.fn(() => 'pending' as const)
    const wait = vi.fn(async () => 'allow' as const)
    const on = cliEventRoutes(deps(undefined, { open, status, wait }))
    expect(await on['POST /v1/cli/permission']!(qs(), preq)).toEqual({ status: 200, body: { status: 'pending', hash: 'k3x9z' } })
    expect(open).toHaveBeenCalledWith(preq)
    expect(await on['GET /v1/cli/permission']!(new URLSearchParams({ hash: 'k3x9z' }), undefined)).toEqual({ status: 200, body: { hash: 'k3x9z', status: 'pending' } })
    expect(await on['GET /v1/cli/permission']!(new URLSearchParams({ hash: 'k3x9z', wait_ms: '99999' }), undefined)).toEqual({ status: 200, body: { hash: 'k3x9z', status: 'allow' } })
    expect(wait).toHaveBeenCalledWith('k3x9z', CLI_PERMISSION_POLL_CAP_MS)
  })
  it('schema + tier', () => {
    const s = REQUEST_SCHEMAS['POST /v1/cli/permission']!
    expect(s.safeParse(preq).success).toBe(true)
    expect(s.safeParse({ ...preq, tool_name: '' }).success).toBe(false)
    const g = REQUEST_SCHEMAS['GET /v1/cli/permission']!
    expect(g.safeParse({ hash: 'k3x9z', wait_ms: '20000' }).success).toBe(true)
    expect(g.safeParse({}).success).toBe(false)
    expect(minTierFor('POST /v1/cli/permission')).toBe('trusted')
    expect(minTierFor('GET /v1/cli/permission')).toBe('trusted')
  })
})
