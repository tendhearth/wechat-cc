import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTeardown } from './teardown'
import { IDLE_SWEEP_MS, wireIdleSweep } from './wire-idle-sweep'

describe('wireIdleSweep', () => {
  afterEach(() => { vi.useRealTimers() })
  it('每拍清扫 + 自重启检查;收尾之后不再拍(复查 10-21:以前关机不停)', async () => {
    vi.useFakeTimers()
    const sweepIdle = vi.fn(async () => {}), check = vi.fn()
    const teardown = makeTeardown()
    wireIdleSweep({ log: () => {}, teardown }, { sessionManager: { sweepIdle }, selfRestartCheck: check })
    await vi.advanceTimersByTimeAsync(IDLE_SWEEP_MS)
    expect(sweepIdle).toHaveBeenCalledTimes(1); expect(check).toHaveBeenCalledTimes(1)
    for (const t of teardown.steps()) await t.stop()
    await vi.advanceTimersByTimeAsync(IDLE_SWEEP_MS * 3)
    expect(sweepIdle).toHaveBeenCalledTimes(1)
  })
})
