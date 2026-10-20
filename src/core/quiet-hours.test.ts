import { describe, expect, it } from 'vitest'
import { parseQuietHours, inQuietHours, quietLabel, quietEndsAt } from './quiet-hours'

describe('quiet hours', () => {
  it('parses HH:MM-HH:MM (also 23-8, 23:00~8:00, 至), off words; rejects junk and empty windows', () => {
    expect(parseQuietHours('23:00-8:00')).toEqual({ ok: true, window: { from: '23:00', to: '08:00' } })
    expect(parseQuietHours('23-8')).toEqual({ ok: true, window: { from: '23:00', to: '08:00' } })
    expect(parseQuietHours('22:30~07:15')).toEqual({ ok: true, window: { from: '22:30', to: '07:15' } })
    expect(parseQuietHours('关')).toEqual({ ok: true, window: null })
    expect(parseQuietHours('off')).toEqual({ ok: true, window: null })
    for (const bad of ['25:00-8:00', '8:00-8:00', 'abc', '23:00', '23:61-1:00']) expect(parseQuietHours(bad).ok, bad).toBe(false)
  })
  it('inQuietHours handles windows that cross midnight, in the owner timezone', () => {
    const w = { from: '23:00', to: '08:00' }
    const at = (hhmm: string) => Date.parse(`2026-10-20T${hhmm}:00+08:00`)
    expect(inQuietHours(w, at('23:30'), 'Asia/Shanghai')).toBe(true)
    expect(inQuietHours(w, at('03:00'), 'Asia/Shanghai')).toBe(true)
    expect(inQuietHours(w, at('07:59'), 'Asia/Shanghai')).toBe(true)
    expect(inQuietHours(w, at('08:00'), 'Asia/Shanghai')).toBe(false)
    expect(inQuietHours(w, at('12:00'), 'Asia/Shanghai')).toBe(false)
    expect(inQuietHours({ from: '13:00', to: '14:00' }, at('13:30'), 'Asia/Shanghai')).toBe(true)
    expect(inQuietHours(undefined, at('03:00'), 'Asia/Shanghai')).toBe(false)
  })
  it('label and when it ends', () => {
    expect(quietLabel({ from: '23:00', to: '08:00' })).toBe('23:00–08:00')
    expect(quietLabel(undefined)).toBe('没设')
    const end = quietEndsAt({ from: '23:00', to: '08:00' }, Date.parse('2026-10-20T23:30:00+08:00'), 'Asia/Shanghai')
    expect(new Date(end!).toISOString()).toBe('2026-10-21T00:00:00.000Z')
  })
})
