import { describe, it, expect, vi } from 'vitest'
import { terminalRoutes, CLI_PERMISSION_POLL_CAP_MS, type TerminalRoutesDeps } from './routes'
import { minTierFor } from '../../daemon/internal-api/route-tiers'
import { REQUEST_SCHEMAS } from '../../daemon/internal-api/schema'

const qs = () => new URLSearchParams()
// 只给用到的那一项:没接线的分支已经没有了(模块门在 internal-api 那一层回 module_starting,见 say-route.test.ts)
const deps = (cliEvents?: Partial<TerminalRoutesDeps['cliEvents']>, cliPermissions?: TerminalRoutesDeps['cliPermissions']): TerminalRoutesDeps => ({ cliEvents, cliPermissions } as unknown as TerminalRoutesDeps)
const body = { source: 'claude', kind: 'stop', session_id: 'abc123', cwd: '/w/p', text: 'done' }

describe('POST /v1/cli/event(spec 2026-09-09-cli-hook-push §6.1)', () => {
  it('转给 hub.ingest,回 action', async () => {
    const ingest = vi.fn(() => 'scheduled' as const)
    const on = terminalRoutes(deps({ ingest }))['POST /v1/cli/event']!
    expect(await on(qs(), body)).toEqual({ status: 200, body: { ok: true, action: 'scheduled' } })
    expect(ingest).toHaveBeenCalledWith(body)
  })

  it('schema:source / kind 只认枚举;session_id、cwd 必填;text 可省', () => {
    const s = REQUEST_SCHEMAS['POST /v1/cli/event']!
    expect(s.safeParse(body).success).toBe(true)
    expect(s.safeParse({ ...body, text: undefined }).success).toBe(true)
    expect(s.safeParse({ ...body, kind: 'prompt', automated: true }).success).toBe(true)
    expect(s.safeParse({ ...body, source: 'cursor' }).success).toBe(true)
    expect(s.safeParse({ ...body, source: 'gemini' }).success).toBe(false)
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
  it('POST → relay.open;GET 不带 wait → status;带 wait → wait(封顶 25s)', async () => {
    const open = vi.fn(async () => ({ status: 'pending' as const, hash: 'k3x9z' }))
    const status = vi.fn(() => 'pending' as const)
    const wait = vi.fn(async () => 'allow' as const)
    const on = terminalRoutes(deps(undefined, { open, status, wait }))
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

describe('GET /v1/cli/sessions(终端会话登记处,v76)', () => {
  it('转给 hub.list(默认 100 条、不含已结束;ended=1 / limit 封顶 500)', async () => {
    const view = { session_id: 'abc123', code: 'abc123', status: 'waiting' }
    const list = vi.fn(() => [view] as never)
    const on = terminalRoutes(deps({ ingest: vi.fn(), list }))['GET /v1/cli/sessions']!
    expect(await on(qs(), undefined)).toEqual({ status: 200, body: { ok: true, sessions: [view] } })
    expect(list).toHaveBeenLastCalledWith({ includeEnded: false, limit: 100 })
    await on(new URLSearchParams({ ended: '1', limit: '9999' }), undefined)
    expect(list).toHaveBeenLastCalledWith({ includeEnded: true, limit: 500 })
  })
  it('admin 档(列出主人所有终端会话的路径与命令);query schema', () => {
    expect(minTierFor('GET /v1/cli/sessions')).toBe('admin')
    const s = REQUEST_SCHEMAS['GET /v1/cli/sessions']!
    expect(s.safeParse({}).success).toBe(true)
    expect(s.safeParse({ ended: '1', limit: '20' }).success).toBe(true)
    expect(s.safeParse({ ended: 'yes' }).success).toBe(false)
    expect(s.safeParse({ limit: '0' }).success).toBe(false)
  })
})

describe('GET /v1/overseer/today(「今天」一眼看完,2026-10-14)', () => {
  it('{ ok, today };抛 → 503 unavailable;admin 档', async () => {
    const today = { generatedAt: 1, counts: { needsYou: 0, done: 0, running: 0, stuck: 0 } }
    const on = terminalRoutes({ overseerToday: () => today } as unknown as TerminalRoutesDeps)['GET /v1/overseer/today']!
    expect(await on(qs(), undefined)).toEqual({ status: 200, body: { ok: true, today } })
    const broken = terminalRoutes({ overseerToday: () => { throw new Error('db gone') } } as unknown as TerminalRoutesDeps)['GET /v1/overseer/today']!
    expect(await broken(qs(), undefined)).toEqual({ status: 503, body: { error: 'unavailable' } })
    expect(minTierFor('GET /v1/overseer/today')).toBe('admin')
  })
})
