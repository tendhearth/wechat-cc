import { afterEach, describe, expect, it, vi } from 'vitest'
import { createModules } from '../modules/container'
import { IDLE_SWEEP_MS, idleSweepModule } from './wire-idle-sweep'

describe('idleSweepModule', () => {
  afterEach(() => { vi.useRealTimers() })
  it('start 段之后每拍清扫 + 自重启检查;停了之后不再拍(复查 10-21:以前关机不停)', async () => {
    vi.useFakeTimers()
    const sweepIdle = vi.fn(async () => {}), check = vi.fn()
    const mods = createModules([
      { name: 'core', init: () => ({ sessionManager: { sweepIdle } }) },
      idleSweepModule({ needs: ['core'] }, (c) => ({ sessionManager: c.get<{ sessionManager: { sweepIdle(): Promise<unknown> } }>('core').sessionManager, selfRestartCheck: () => check, log: () => {} })),
    ], { log: () => {} })
    await vi.advanceTimersByTimeAsync(IDLE_SWEEP_MS)
    expect(sweepIdle).not.toHaveBeenCalled()   // 还没 start
    await mods.start()
    await vi.advanceTimersByTimeAsync(IDLE_SWEEP_MS)
    expect(sweepIdle).toHaveBeenCalledTimes(1); expect(check).toHaveBeenCalledTimes(1)
    await mods.stopAll()
    await vi.advanceTimersByTimeAsync(IDLE_SWEEP_MS * 3)
    expect(sweepIdle).toHaveBeenCalledTimes(1)
  })
  it('自重启没起(检查是 null)⇒ 照样清扫', async () => {
    vi.useFakeTimers()
    const sweepIdle = vi.fn(async () => {})
    const mods = createModules([
      { name: 'core', init: () => ({}) },
      idleSweepModule({ needs: ['core'] }, () => ({ sessionManager: { sweepIdle }, selfRestartCheck: () => null, log: () => {} })),
    ], { log: () => {} })
    await mods.start()
    await vi.advanceTimersByTimeAsync(IDLE_SWEEP_MS)
    expect(sweepIdle).toHaveBeenCalledTimes(1)
    await mods.stopAll()
  })
})
