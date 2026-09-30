import { describe, it, expect } from 'vitest'
import { LIMITS, limitsFrom, makeBucket, utcDay, utf8Len } from '../src/limits'

describe('limits', () => {
  it('spec §6 的缺省值', () => {
    expect(LIMITS).toMatchObject({
      maxPhoneStreams: 16, maxFrameBytes: 512 * 1024,
      phoneRate: { capacity: 120, refillPerSec: 20 }, daemonRate: { capacity: 1000, refillPerSec: 200 },
      dailyPushes: 500, dailyBytes: 1_000_000_000, loginTimeoutMs: 10_000,
    })
  })
  it('env 覆盖(字符串),非法值回落缺省', () => {
    expect(limitsFrom({ RELAY_DAILY_PUSHES: '3', RELAY_DAILY_BYTES: 'x' } as Env)).toMatchObject({ dailyPushes: 3, dailyBytes: 1_000_000_000 })
  })
  it('令牌桶:突发用完即拒,按时间补', () => {
    const b = makeBucket(2, 1)
    expect(b.take(0)).toBe(true)
    expect(b.take(0)).toBe(true)
    expect(b.take(0)).toBe(false)
    expect(b.take(1000)).toBe(true)
  })
  it('utcDay / utf8Len', () => {
    expect(utcDay(Date.UTC(2026, 8, 30, 23, 59))).toBe('2026-09-30')
    expect(utf8Len('a中')).toBe(4)
  })
})
