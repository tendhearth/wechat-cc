import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { startCompanionScheduler, STOP_WAIT_CAP_MS } from './scheduler'

/** Fake busy-registry (spec 2026-08-11 §2) — tracks active holds by count. */
function makeFakeRegistry() {
  let active = 0
  const holdBusy = vi.fn((_label: string) => {
    active++
    let released = false
    return () => {
      if (released) return
      released = true
      active--
    }
  })
  return { holdBusy, busy: () => active > 0 }
}

describe('startCompanionScheduler', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('fires onTick when enabled + not snoozed', async () => {
    const onTick = vi.fn().mockResolvedValue(undefined)
    const stop = startCompanionScheduler({
      intervalMs: 1000,
      jitterRatio: 0,
      shouldRun: () => true,
      onTick,
      log: () => {},
    })
    await vi.advanceTimersByTimeAsync(1100)
    expect(onTick).toHaveBeenCalled()
    await stop()
  })

  it('does not stall scheduling when a tick hangs (bounded by tickTimeoutMs)', async () => {
    let calls = 0
    const onTick = vi.fn(() => {
      calls++
      // First tick never resolves (a wedged agenda read / dispatch). The
      // scheduler must NOT wait forever — it should time the tick out and keep
      // firing subsequent ticks.
      return calls === 1 ? new Promise<void>(() => {}) : Promise.resolve()
    })
    const stop = startCompanionScheduler({
      intervalMs: 1000, jitterRatio: 0, tickTimeoutMs: 500,
      shouldRun: () => true, onTick, log: () => {},
    })
    // tick#1 fires @1000 (hangs) → tick timeout @1500 → reschedule → tick#2 @2500
    await vi.advanceTimersByTimeAsync(3000)
    expect(onTick).toHaveBeenCalledTimes(2)
    await stop()
  })

  it('does not fire when disabled', async () => {
    const onTick = vi.fn()
    const stop = startCompanionScheduler({
      intervalMs: 1000, jitterRatio: 0,
      shouldRun: () => false,
      onTick, log: () => {},
    })
    await vi.advanceTimersByTimeAsync(1100)
    expect(onTick).not.toHaveBeenCalled()
    await stop()
  })

  it('does not fire when snoozed', async () => {
    const onTick = vi.fn()
    const stop = startCompanionScheduler({
      intervalMs: 1000, jitterRatio: 0,
      shouldRun: () => false,
      onTick, log: () => {},
    })
    await vi.advanceTimersByTimeAsync(1100)
    expect(onTick).not.toHaveBeenCalled()
    await stop()
  })

  it('keeps scheduling after exceptions', async () => {
    const onTick = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined)
    const log = vi.fn()
    const stop = startCompanionScheduler({
      intervalMs: 1000, jitterRatio: 0,
      shouldRun: () => true,
      onTick, log,
    })
    await vi.advanceTimersByTimeAsync(1100)
    expect(onTick).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith('SCHED', expect.stringContaining('boom'))
    await vi.advanceTimersByTimeAsync(1100)
    expect(onTick).toHaveBeenCalledTimes(2)
    await stop()
  })

  it('stop() halts future ticks', async () => {
    const onTick = vi.fn()
    const stop = startCompanionScheduler({
      intervalMs: 1000, jitterRatio: 0,
      shouldRun: () => true,
      onTick, log: () => {},
    })
    await stop()
    await vi.advanceTimersByTimeAsync(5000)
    expect(onTick).not.toHaveBeenCalled()
  })

  it('uses name in startup log when provided', async () => {
    const logs: string[] = []
    const stop = startCompanionScheduler({
      intervalMs: 1000, jitterRatio: 0,
      shouldRun: () => false,
      onTick: async () => {},
      log: (tag, line) => logs.push(`${tag} ${line}`),
      name: 'push',
    })
    expect(logs.some(l => l.includes('push scheduler started'))).toBe(true)
    await stop()
  })

  it('calls shouldRun exactly once per tick (atomic gate, not two separate reads)', async () => {
    // Pre-PR D the scheduler called both isEnabled() and isSnoozed() per
    // tick — two separate config reads with a race window between them
    // where `开启 companion` + `别烦我` arriving in sequence could be
    // misread. With one merged gate the scheduler hits it once per tick.
    const shouldRun = vi.fn(() => true)
    const stop = startCompanionScheduler({
      intervalMs: 1000, jitterRatio: 0,
      shouldRun,
      onTick: async () => {},
      log: () => {},
    })
    await vi.advanceTimersByTimeAsync(1100)
    expect(shouldRun).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1100)
    expect(shouldRun).toHaveBeenCalledTimes(2)
    await stop()
  })

  it('falls back to "companion" when no name provided', async () => {
    const logs: string[] = []
    const stop = startCompanionScheduler({
      intervalMs: 1000, jitterRatio: 0,
      shouldRun: () => false,
      onTick: async () => {},
      log: (tag, line) => logs.push(`${tag} ${line}`),
    })
    expect(logs.some(l => l.includes('companion scheduler started'))).toBe(true)
    await stop()
  })
})

// ─── busy-registry hold + graceful stop (spec 2026-08-11 §2/§6, Task 5) ────
//
// ingest's silence threshold is stricter than the self-restart idle
// threshold — a running tick is exactly the work most likely to be
// misjudged as "idle" and killed by the self-restart check. The scheduler
// must hold a busy token for the duration of a real onTick, and stop()
// must wait for an in-flight tick to actually finish (bounded) instead of
// yanking the timer and calling it graceful.
describe('startCompanionScheduler — busy hold + graceful stop', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('holds a busy token for the duration of a running tick, released once it resolves', async () => {
    const registry = makeFakeRegistry()
    let resolveTick: (() => void) | undefined
    const onTick = vi.fn(() => new Promise<void>((res) => { resolveTick = res }))
    const stop = startCompanionScheduler({
      intervalMs: 1000, jitterRatio: 0,
      shouldRun: () => true,
      onTick, log: () => {},
      holdBusy: registry.holdBusy,
    })

    await vi.advanceTimersByTimeAsync(1100)
    expect(onTick).toHaveBeenCalledTimes(1)
    expect(registry.busy()).toBe(true)

    resolveTick?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(registry.busy()).toBe(false)

    await stop()
  })

  it('releases the busy token even when onTick rejects', async () => {
    const registry = makeFakeRegistry()
    const onTick = vi.fn().mockRejectedValue(new Error('boom'))
    const stop = startCompanionScheduler({
      intervalMs: 1000, jitterRatio: 0,
      shouldRun: () => true,
      onTick, log: () => {},
      holdBusy: registry.holdBusy,
    })

    await vi.advanceTimersByTimeAsync(1100)
    expect(onTick).toHaveBeenCalledTimes(1)
    expect(registry.busy()).toBe(false)

    await stop()
  })

  it('a holdBusy that throws never blocks the tick from running (defensive catch)', async () => {
    const onTick = vi.fn().mockResolvedValue(undefined)
    const holdBusy = vi.fn(() => { throw new Error('registry exploded') })
    const stop = startCompanionScheduler({
      intervalMs: 1000, jitterRatio: 0,
      shouldRun: () => true,
      onTick, log: () => {},
      holdBusy,
    })
    await vi.advanceTimersByTimeAsync(1100)
    expect(onTick).toHaveBeenCalledTimes(1)
    await stop()
  })

  it('does not hold a token for a tick that shouldRun() skips', async () => {
    const registry = makeFakeRegistry()
    const onTick = vi.fn()
    const stop = startCompanionScheduler({
      intervalMs: 1000, jitterRatio: 0,
      shouldRun: () => false,
      onTick, log: () => {},
      holdBusy: registry.holdBusy,
    })
    await vi.advanceTimersByTimeAsync(1100)
    expect(onTick).not.toHaveBeenCalled()
    expect(registry.holdBusy).not.toHaveBeenCalled()
    await stop()
  })

  it('stop() waits for an in-flight tick to finish before resolving', async () => {
    const registry = makeFakeRegistry()
    let resolveTick: (() => void) | undefined
    const onTick = vi.fn(() => new Promise<void>((res) => { resolveTick = res }))
    const stop = startCompanionScheduler({
      intervalMs: 1000, jitterRatio: 0,
      shouldRun: () => true,
      onTick, log: () => {},
      holdBusy: registry.holdBusy,
    })

    await vi.advanceTimersByTimeAsync(1100)
    expect(onTick).toHaveBeenCalledTimes(1)

    let stopSettled = false
    const stopPromise = stop().then(() => { stopSettled = true })
    // stop() must not resolve while the tick is still running.
    await vi.advanceTimersByTimeAsync(0)
    expect(stopSettled).toBe(false)

    resolveTick?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(stopSettled).toBe(true)
    expect(registry.busy()).toBe(false)

    await stopPromise
  })

  it('clears the stop-wait cap timer when the in-flight tick wins the race — no leaked timer', async () => {
    // Regression: Promise.race([pending, new Promise(r => setTimeout(r, CAP))])
    // without capturing the setTimeout handle leaks a timer whenever `pending`
    // settles first — the cap timer stays armed in the event loop for the
    // full STOP_WAIT_CAP_MS after shutdown. Three schedulers (push/ingest/
    // introspect) stopping together would leave up to 3 stray timers.
    let resolveTick: (() => void) | undefined
    const onTick = vi.fn(() => new Promise<void>((res) => { resolveTick = res }))
    const stop = startCompanionScheduler({
      intervalMs: 1000, jitterRatio: 0,
      shouldRun: () => true,
      onTick, log: () => {},
    })

    await vi.advanceTimersByTimeAsync(1100)
    expect(onTick).toHaveBeenCalledTimes(1)

    const stopPromise = stop()
    resolveTick?.()   // pending wins the race, well before the 4s cap
    await stopPromise

    // Nothing should still be armed — no cap timer, no re-armed scheduler
    // timer (stop() marks stopped before scheduleNext() re-checks it), no
    // tickTimeoutMs guard (cleared by runBoundedTick's own finally once
    // onTick settles).
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stop() gives up after STOP_WAIT_CAP_MS if the tick never finishes', async () => {
    const onTick = vi.fn(() => new Promise<void>(() => {})) // never resolves
    const stop = startCompanionScheduler({
      intervalMs: 1000, jitterRatio: 0,
      shouldRun: () => true,
      onTick, log: () => {},
    })

    await vi.advanceTimersByTimeAsync(1100)
    expect(onTick).toHaveBeenCalledTimes(1)

    let stopSettled = false
    const stopPromise = stop().then(() => { stopSettled = true })

    await vi.advanceTimersByTimeAsync(STOP_WAIT_CAP_MS - 1)
    expect(stopSettled).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    expect(stopSettled).toBe(true)

    await stopPromise
  })

  it('stop() resolves immediately when there is no in-flight tick', async () => {
    const stop = startCompanionScheduler({
      intervalMs: 1000, jitterRatio: 0,
      shouldRun: () => true,
      onTick: async () => {},
      log: () => {},
    })
    let stopSettled = false
    const stopPromise = stop().then(() => { stopSettled = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(stopSettled).toBe(true)
    await stopPromise
  })
})
