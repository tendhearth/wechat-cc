import { describe, expect, it, vi } from 'vitest'
import { calendarRoutes } from './routes-calendar'
import { minTierFor } from './route-tiers'
import type { InternalApiDeps } from './types'

const q = (s = '') => new URLSearchParams(s)
const deps = (calendarAgenda?: InternalApiDeps['calendarAgenda']) => ({ calendarAgenda } as unknown as InternalApiDeps)

describe('GET /v1/calendar/agenda(读日历,对标 #8)', () => {
  it('not wired ⇒ 503; offset 0 / 1 only (default 0); returns the same text as the 日历 command; admin tier', async () => {
    expect(await calendarRoutes(deps())['GET /v1/calendar/agenda']!(q(), undefined)).toEqual({ status: 503, body: { error: 'calendar_not_wired' } })
    const agenda = vi.fn(async (o: 0 | 1) => `${o === 0 ? '今天' : '明天'}的安排:\n- 10:00–11:00 评审(工作)`)
    const r = calendarRoutes(deps(agenda))['GET /v1/calendar/agenda']!
    expect(await r(q(), undefined)).toEqual({ status: 200, body: { ok: true, text: '今天的安排:\n- 10:00–11:00 评审(工作)' } })
    expect(await r(q('offset=1'), undefined)).toMatchObject({ status: 200, body: { ok: true } })
    expect(agenda).toHaveBeenLastCalledWith(1)
    expect(await r(q('offset=7'), undefined)).toEqual({ status: 400, body: { error: 'invalid_offset' } })
    expect(minTierFor('GET /v1/calendar/agenda')).toBe('admin')
  })
  it('throws ⇒ 503 unavailable', async () => {
    const r = calendarRoutes(deps(async () => { throw new Error('osascript') }))['GET /v1/calendar/agenda']!
    expect(await r(q(), undefined)).toEqual({ status: 503, body: { error: 'unavailable' } })
  })
})
