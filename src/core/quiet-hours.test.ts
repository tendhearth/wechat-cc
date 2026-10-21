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
    expect(inQuietHours(w, at('22:59'), 'Asia/Shanghai')).toBe(false)
    expect(inQuietHours(w, at('23:00'), 'Asia/Shanghai')).toBe(true)   // 起点整点算在里面
    expect(inQuietHours(w, at('23:30'), 'Asia/Shanghai')).toBe(true)
    expect(inQuietHours(w, at('03:00'), 'Asia/Shanghai')).toBe(true)
    expect(inQuietHours(w, at('07:59'), 'Asia/Shanghai')).toBe(true)
    expect(inQuietHours(w, at('08:00'), 'Asia/Shanghai')).toBe(false)
    expect(inQuietHours(w, at('12:00'), 'Asia/Shanghai')).toBe(false)
    expect(inQuietHours({ from: '13:00', to: '14:00' }, at('12:59'), 'Asia/Shanghai')).toBe(false)
    expect(inQuietHours({ from: '13:00', to: '14:00' }, at('13:00'), 'Asia/Shanghai')).toBe(true)
    expect(inQuietHours({ from: '13:00', to: '14:00' }, at('13:30'), 'Asia/Shanghai')).toBe(true)
    expect(inQuietHours({ from: '13:00', to: '14:00' }, at('14:00'), 'Asia/Shanghai')).toBe(false)   // 终点整点算在外面
    expect(inQuietHours(undefined, at('03:00'), 'Asia/Shanghai')).toBe(false)
  })
  it('label and when it ends', () => {
    expect(quietLabel({ from: '23:00', to: '08:00' })).toBe('23:00–08:00')
    expect(quietLabel(undefined)).toBe('没设')
    const end = quietEndsAt({ from: '23:00', to: '08:00' }, Date.parse('2026-10-20T23:30:00+08:00'), 'Asia/Shanghai')
    expect(new Date(end!).toISOString()).toBe('2026-10-21T00:00:00.000Z')
  })
})

describe('hhmmInQuiet —— 晨报时间落不落在免打扰里', () => {
  it('当天的窗口 / 跨午夜的窗口 / 边界(开头算、结尾不算)/ 没设', async () => {
    const { hhmmInQuiet } = await import('./quiet-hours')
    expect(hhmmInQuiet('13:00', { from: '12:00', to: '14:00' })).toBe(true)
    expect(hhmmInQuiet('08:00', { from: '23:00', to: '08:30' })).toBe(true)
    expect(hhmmInQuiet('08:30', { from: '23:00', to: '08:30' })).toBe(false)
    expect(hhmmInQuiet('23:00', { from: '23:00', to: '08:30' })).toBe(true)
    expect(hhmmInQuiet('09:00', { from: '23:00', to: '08:30' })).toBe(false)
    expect(hhmmInQuiet('09:00', undefined)).toBe(false)
  })
})
