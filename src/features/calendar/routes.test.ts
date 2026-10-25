import { describe, expect, it, vi } from 'vitest'
import { calendarRoutes } from './routes'
import { minTierFor, moduleFor } from '../../daemon/internal-api/route-tiers'
import type { Calendar } from './calendar'

const q = (s = '') => new URLSearchParams(s)
const cal = (agenda: Calendar['agenda']) => ({ agenda } as unknown as Calendar)

describe('GET /v1/calendar/agenda(读日历,对标 #8)', () => {
  it('offset 0 / 1 only (default 0); returns the same text as the 日历 command; admin tier; mounted by the calendar module', async () => {
    const agenda = vi.fn(async (o: 0 | 1) => ({ ok: true as const, text: o === 0 ? '- 10:00–11:00 评审(工作)' : '' }))
    const r = calendarRoutes(cal(agenda))['GET /v1/calendar/agenda']!
    expect(await r(q(), undefined)).toEqual({ status: 200, body: { ok: true, text: '今天的安排:\n- 10:00–11:00 评审(工作)' } })
    expect(await r(q('offset=1'), undefined)).toEqual({ status: 200, body: { ok: true, text: '明天日历和提醒事项里都没有安排。' } })
    expect(agenda).toHaveBeenLastCalledWith(1)
    expect(await r(q('offset=7'), undefined)).toEqual({ status: 400, body: { error: 'invalid_offset' } })
    expect(minTierFor('GET /v1/calendar/agenda')).toBe('admin')
    expect(moduleFor('GET /v1/calendar/agenda')).toBe('calendar')
  })
  it('没授权照实说(不说成没安排)', async () => {
    const r = calendarRoutes(cal(async () => ({ ok: false as const, reason: 'denied' as const })))['GET /v1/calendar/agenda']!
    const res = await r(q(), undefined) as { body: { text: string } }
    expect(res.body.text).toMatch(/权限/)
  })
  it('throws ⇒ 503 unavailable', async () => {
    const r = calendarRoutes(cal(async () => { throw new Error('osascript') }))['GET /v1/calendar/agenda']!
    expect(await r(q(), undefined)).toEqual({ status: 503, body: { error: 'unavailable' } })
  })
})
