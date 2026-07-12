import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { registerCompanionPush, registerCompanionIntrospect, registerIngest } from './lifecycle'

describe('registerCompanionPush', () => {
  it('returns a Lifecycle with name=companion-push', () => {
    const lc = registerCompanionPush({
      shouldRun: () => false,
      log: () => {},
      onTick: async () => {},
    })
    expect(lc.name).toBe('companion-push')
    expect(typeof lc.stop).toBe('function')
  })

  it('stop() is idempotent', async () => {
    const lc = registerCompanionPush({
      shouldRun: () => false,
      log: () => {},
      onTick: async () => {},
    })
    await lc.stop()
    await expect(lc.stop()).resolves.toBeUndefined()
  })
})

describe('registerCompanionIntrospect', () => {
  it('returns a Lifecycle with name=companion-introspect', () => {
    const lc = registerCompanionIntrospect({
      shouldRun: () => false,
      log: () => {},
      onTick: async () => {},
    })
    expect(lc.name).toBe('companion-introspect')
  })
})

describe('intervalMs override', () => {
  // 1B ms ≈ 11.5 days. Chosen so even after the scheduler's ±30% jitter the
  // resulting setTimeout delay (≤1.3B ms) stays under int32 max (~2.15B ms).
  // Passing the raw int32 max would overflow when multiplied by jitter and
  // Node would clamp the timer to ~1ms — defeating the suppression intent.
  const SAFE_INFINITY_MS = 1_000_000_000

  it('honors an intervalMs override (push)', () => {
    const onTick = vi.fn(async () => {})
    // SAFE_INFINITY-style large value so the scheduler never fires within the test.
    const lc = registerCompanionPush({
      shouldRun: () => true,
      log: () => {},
      onTick,
      intervalMs: SAFE_INFINITY_MS,
    })
    // No assertion on tick count — just verify the call doesn't crash and the
    // scheduler accepts the override. setTimeout with INT32_MAX is well-formed.
    expect(lc.name).toBe('companion-push')
    return lc.stop()
  })

  it('honors an intervalMs override (introspect)', () => {
    const onTick = vi.fn(async () => {})
    const lc = registerCompanionIntrospect({
      shouldRun: () => true,
      log: () => {},
      onTick,
      intervalMs: SAFE_INFINITY_MS,
    })
    expect(lc.name).toBe('companion-introspect')
    return lc.stop()
  })
})

describe('registerIngest — new-message nudge (debounced)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  // A huge base interval keeps the 25-min cadence from firing during the test;
  // we only exercise the nudge path.
  function make(over: { shouldRun?: () => boolean } = {}) {
    const onTick = vi.fn(async () => {})
    const lc = registerIngest({
      shouldRun: over.shouldRun ?? (() => true),
      log: () => {},
      onTick,
      intervalMs: 1e9,
      nudgeDelayMs: 1000,
    })
    return { lc, onTick }
  }

  it('collapses rapid nudges to a single fire after the debounce settles', async () => {
    const { lc, onTick } = make()
    lc.nudge(); lc.nudge(); lc.nudge()          // burst
    await vi.advanceTimersByTimeAsync(999)
    expect(onTick).not.toHaveBeenCalled()        // still within debounce
    await vi.advanceTimersByTimeAsync(1)
    expect(onTick).toHaveBeenCalledTimes(1)      // exactly one fire
    await lc.stop()
  })

  it('trailing: a later nudge resets the timer (fires once, after the LAST nudge)', async () => {
    const { lc, onTick } = make()
    lc.nudge()
    await vi.advanceTimersByTimeAsync(800)
    lc.nudge()                                   // resets the 1000ms window
    await vi.advanceTimersByTimeAsync(800)
    expect(onTick).not.toHaveBeenCalled()        // 800ms since last nudge < 1000
    await vi.advanceTimersByTimeAsync(200)
    expect(onTick).toHaveBeenCalledTimes(1)
    await lc.stop()
  })

  it('does not fire when shouldRun is false at fire time', async () => {
    const { lc, onTick } = make({ shouldRun: () => false })
    lc.nudge()
    await vi.advanceTimersByTimeAsync(1000)
    expect(onTick).not.toHaveBeenCalled()
    await lc.stop()
  })

  it('a nudge after stop() never fires', async () => {
    const { lc, onTick } = make()
    await lc.stop()
    lc.nudge()
    await vi.advanceTimersByTimeAsync(2000)
    expect(onTick).not.toHaveBeenCalled()
  })
})
