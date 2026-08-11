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

// busy-registry hold forwarding (spec 2026-08-11 §2, Task 5 gap closed by
// Task 6) — Task 5 taught scheduler.ts to accept an optional holdBusy, but
// left CompanionPushDeps/IngestDeps/IntrospectDeps not forwarding it, so
// production wiring (registerCompanionPush/Ingest/Introspect called from
// main.ts via src/daemon/wiring/lifecycle-deps.ts) never actually reached
// the scheduler with a real token. These tests prove all three register*
// functions now forward `deps.holdBusy` through to the running tick —
// scheduler.test.ts already covers the hold/release mechanics themselves,
// so this only needs to prove the field crosses the lifecycle.ts seam.
describe('holdBusy forwarding', () => {
  const SAFE_INFINITY_MS = 1_000_000_000

  it('registerCompanionPush forwards holdBusy to the running tick', async () => {
    const holdBusy = vi.fn(() => vi.fn())
    let resolveTick: () => void = () => {}
    const onTick = vi.fn(() => new Promise<void>(resolve => { resolveTick = resolve }))
    const lc = registerCompanionPush({
      shouldRun: () => true,
      log: () => {},
      onTick,
      intervalMs: 50,
      holdBusy,
    })
    await vi.waitFor(() => expect(holdBusy).toHaveBeenCalledWith('companion-push'))
    resolveTick()
    await lc.stop()
  })

  it('registerIngest forwards holdBusy to the running tick', async () => {
    const holdBusy = vi.fn(() => vi.fn())
    let resolveTick: () => void = () => {}
    const onTick = vi.fn(() => new Promise<void>(resolve => { resolveTick = resolve }))
    const lc = registerIngest({
      shouldRun: () => true,
      log: () => {},
      onTick,
      intervalMs: 50,
      holdBusy,
    })
    await vi.waitFor(() => expect(holdBusy).toHaveBeenCalledWith('companion-ingest'))
    resolveTick()
    await lc.stop()
  })

  it('registerCompanionIntrospect forwards holdBusy to the running tick', async () => {
    const holdBusy = vi.fn(() => vi.fn())
    let resolveTick: () => void = () => {}
    const onTick = vi.fn(() => new Promise<void>(resolve => { resolveTick = resolve }))
    const lc = registerCompanionIntrospect({
      shouldRun: () => true,
      log: () => {},
      onTick,
      intervalMs: 50,
      holdBusy,
    })
    await vi.waitFor(() => expect(holdBusy).toHaveBeenCalledWith('companion-introspect'))
    resolveTick()
    await lc.stop()
  })

  it('holdBusy absent stays a safe no-op — same posture as before this field existed', () => {
    const lc = registerCompanionPush({
      shouldRun: () => false,
      log: () => {},
      onTick: async () => {},
      intervalMs: SAFE_INFINITY_MS,
    })
    expect(lc.name).toBe('companion-push')
    return lc.stop()
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

  // C1 fix (code review, 2026-08-11): nudge() used to call `deps.onTick()`
  // directly, bypassing the scheduler entirely — a nudge-triggered ingest
  // run held no busy token and stop() never waited for it. The nudge fires
  // NUDGE_DELAY_MS (3 min) into silence, i.e. right as `quietFor` crosses
  // the self-restart idle threshold (120s) — so this was the single
  // highest-probability way for the self-restart mechanism to kill a live
  // ingest cycle. nudge() now routes through scheduler.runNow(), the SAME
  // held+guarded+tracked path a cadence tick uses.
  it('a nudge-triggered tick holds a busy-registry token while running, released once it settles', async () => {
    let active = 0
    const release = vi.fn(() => { active-- })
    const holdBusy = vi.fn((label: string) => { expect(label).toBe('companion-ingest'); active++; return release })
    let resolveTick: () => void = () => {}
    const onTick = vi.fn(() => new Promise<void>(resolve => { resolveTick = resolve }))
    const lc = registerIngest({
      shouldRun: () => true,
      log: () => {},
      onTick,
      intervalMs: 1e9,
      nudgeDelayMs: 1000,
      holdBusy,
    })

    lc.nudge()
    await vi.advanceTimersByTimeAsync(1000)
    expect(onTick).toHaveBeenCalledTimes(1)
    expect(holdBusy).toHaveBeenCalledTimes(1)
    expect(active).toBe(1)   // busy while the nudge-triggered tick runs

    resolveTick()
    await vi.advanceTimersByTimeAsync(0)
    expect(release).toHaveBeenCalledTimes(1)
    expect(active).toBe(0)

    await lc.stop()
  })

  it('stop() waits (bounded) for a nudge-triggered tick in flight before resolving', async () => {
    let resolveTick: () => void = () => {}
    const onTick = vi.fn(() => new Promise<void>(resolve => { resolveTick = resolve }))
    const lc = registerIngest({
      shouldRun: () => true,
      log: () => {},
      onTick,
      intervalMs: 1e9,
      nudgeDelayMs: 1000,
    })

    lc.nudge()
    await vi.advanceTimersByTimeAsync(1000)
    expect(onTick).toHaveBeenCalledTimes(1)

    let stopSettled = false
    const stopPromise = lc.stop().then(() => { stopSettled = true })
    // stop() must not resolve while the nudge-triggered tick is still running.
    await vi.advanceTimersByTimeAsync(0)
    expect(stopSettled).toBe(false)

    resolveTick()
    await vi.advanceTimersByTimeAsync(0)
    expect(stopSettled).toBe(true)

    await stopPromise
  })
})
