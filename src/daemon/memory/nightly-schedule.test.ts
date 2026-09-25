import { describe, it, expect } from 'vitest'
import { localParts, isDue, noticeTiming } from './nightly-schedule'

const SH = 'Asia/Shanghai'
const at = (iso: string) => Date.parse(iso)

describe('nightly schedule', () => {
  it('reads the local day and clock in the owner timezone, falling back to UTC', () => {
    expect(localParts(at('2026-09-24T20:30:00Z'), SH)).toEqual({ day: '2026-09-25', hhmm: '04:30' })
    expect(localParts(at('2026-09-24T20:30:00Z'), 'Not/AZone')).toEqual({ day: '2026-09-24', hhmm: '20:30' })
  })
  it('is due once per local day after the configured time — including catch-up after sleeping through it', () => {
    expect(isDue({ nowMs: at('2026-09-24T19:59:00Z'), tz: SH, at: '04:00', lastRunDay: '2026-09-24' })).toBe(false)   // 03:59
    expect(isDue({ nowMs: at('2026-09-24T20:00:00Z'), tz: SH, at: '04:00', lastRunDay: '2026-09-24' })).toBe(true)    // 04:00
    expect(isDue({ nowMs: at('2026-09-25T00:10:00Z'), tz: SH, at: '04:00', lastRunDay: '2026-09-24' })).toBe(true)    // 08:10 woke up
    expect(isDue({ nowMs: at('2026-09-25T00:10:00Z'), tz: SH, at: '04:00', lastRunDay: '2026-09-25' })).toBe(false)   // already ran
    expect(isDue({ nowMs: at('2026-09-24T16:30:00Z'), tz: SH, at: '04:00', lastRunDay: '2026-09-24' })).toBe(false)   // 00:30 new day, too early
  })
  it('holds notices until 09:00 local and drops them after 24h', () => {
    const created = at('2026-09-24T20:00:00Z')   // 04:00
    expect(noticeTiming({ nowMs: at('2026-09-25T00:59:00Z'), tz: SH, createdAtMs: created })).toBe('wait')    // 08:59
    expect(noticeTiming({ nowMs: at('2026-09-25T01:00:00Z'), tz: SH, createdAtMs: created })).toBe('send')    // 09:00
    expect(noticeTiming({ nowMs: at('2026-09-25T20:00:01Z'), tz: SH, createdAtMs: created })).toBe('expire')
  })
})
