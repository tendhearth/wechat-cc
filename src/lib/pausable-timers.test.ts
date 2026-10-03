import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePausableTimers } from './pausable-timers'

describe('makePausableTimers (fake clock)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('fires normally when never paused', () => {
    const t = makePausableTimers(), fn = vi.fn()
    t.set(fn, 1000)
    vi.advanceTimersByTime(999); expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1); expect(fn).toHaveBeenCalledTimes(1)
  })

  it('paused time does not count: 600ms elapsed, paused 30 min, then fires 400ms after resume', () => {
    const t = makePausableTimers(), fn = vi.fn()
    t.set(fn, 1000)
    vi.advanceTimersByTime(600)
    t.pause()
    vi.advanceTimersByTime(30 * 60_000)
    expect(fn).not.toHaveBeenCalled()
    t.resume()
    vi.advanceTimersByTime(399); expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1); expect(fn).toHaveBeenCalledTimes(1)
  })

  it('a timer set while paused starts counting only on resume; clear works in both states', () => {
    const t = makePausableTimers(), a = vi.fn(), b = vi.fn()
    t.pause()
    const ha = t.set(a, 100)
    const hb = t.set(b, 100)
    t.clear(hb)
    vi.advanceTimersByTime(10_000)
    expect(a).not.toHaveBeenCalled()
    t.resume()
    vi.advanceTimersByTime(100)
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).not.toHaveBeenCalled()
    t.clear(ha)  // already fired: no-op
    expect(t.paused).toBe(false)
  })
})
