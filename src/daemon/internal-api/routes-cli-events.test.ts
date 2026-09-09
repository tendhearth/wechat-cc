import { describe, it, expect, vi } from 'vitest'
import { cliEventRoutes } from './routes-cli-events'
import { minTierFor } from './route-tiers'
import { REQUEST_SCHEMAS } from './schema'
import type { InternalApiDeps } from './types'

const qs = () => new URLSearchParams()
const deps = (cliEvents?: InternalApiDeps['cliEvents']): InternalApiDeps => ({ cliEvents } as unknown as InternalApiDeps)
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
