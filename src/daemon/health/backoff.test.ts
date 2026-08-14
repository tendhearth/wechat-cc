import { describe, it, expect } from 'vitest'
import { nextBackoffMs, BACKOFF_BASE_MS, BACKOFF_CAP_MS } from './backoff'

// random: () => 0.5 ⇒ 抖动系数正好为 1,便于断言确定值
const noJitter = { random: () => 0.5 }

describe('nextBackoffMs', () => {
  it('从 2 秒起指数增长,封顶 60 秒', () => {
    const seq = [0, 1, 2, 3, 4, 5, 6, 20].map(a => nextBackoffMs(a, noJitter))
    expect(seq).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000])
  })

  it('封顶取正常轮询节奏 —— 重试不该比正常工作还密集', () => {
    // LONG_POLL_TIMEOUT_MS = 35_000;封顶必须不小于它。
    expect(BACKOFF_CAP_MS).toBeGreaterThanOrEqual(35_000)
    expect(BACKOFF_BASE_MS).toBe(2_000)
  })

  it('抖动落在 ±20% 内', () => {
    const lo = nextBackoffMs(10, { random: () => 0 })
    const hi = nextBackoffMs(10, { random: () => 1 })
    expect(lo).toBe(Math.round(BACKOFF_CAP_MS * 0.8))
    expect(hi).toBe(Math.round(BACKOFF_CAP_MS * 1.2))
  })

  it('负数 attempt 当作 0', () => {
    expect(nextBackoffMs(-3, noJitter)).toBe(2_000)
  })
})
