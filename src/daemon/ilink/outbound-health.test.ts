import { describe, it, expect, vi } from 'vitest'
import { makeOutboundHealthTracker, isProactiveWindowClosed } from './outbound-health'

const T0 = '2026-08-22T10:00:00.000Z'
const T1 = '2026-08-22T10:01:00.000Z'
const T2 = '2026-08-22T10:05:00.000Z'

describe('outbound health tracker', () => {
  it('starts unknown with empty fields', () => {
    const t = makeOutboundHealthTracker({ log: () => {} })
    expect(t.snapshot()).toEqual({
      state: 'unknown', consecutiveFailures: 0,
      lastOkAt: null, lastFailAt: null, lastError: null, episodeStartedAt: null,
    })
  })

  it('one failure stays below the default threshold (no state flip, no log)', () => {
    const log = vi.fn()
    const t = makeOutboundHealthTracker({ log })
    t.recordFailure(T0, 'errcode=-2: prepare failed')
    const s = t.snapshot()
    expect(s.state).toBe('unknown')          // never sent ok, threshold not reached
    expect(s.consecutiveFailures).toBe(1)
    expect(s.lastFailAt).toBe(T0)
    expect(s.lastError).toBe('errcode=-2: prepare failed')
    expect(log).not.toHaveBeenCalled()
  })

  it('second failure flips to degraded with exactly one OUTBOUND log line and episode start', () => {
    const log = vi.fn()
    const t = makeOutboundHealthTracker({ log })
    t.recordFailure(T0, 'e1')
    t.recordFailure(T1, 'e2')
    const s = t.snapshot()
    expect(s.state).toBe('degraded')
    expect(s.consecutiveFailures).toBe(2)
    expect(s.episodeStartedAt).toBe(T0)      // episode began at FIRST failure of the run
    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith('OUTBOUND', 'degraded — 2 consecutive failures, last: e2')
  })

  it('third failure while degraded logs nothing more', () => {
    const log = vi.fn()
    const t = makeOutboundHealthTracker({ log })
    t.recordFailure(T0, 'e1'); t.recordFailure(T1, 'e2'); t.recordFailure(T2, 'e3')
    expect(log).toHaveBeenCalledTimes(1)
    expect(t.snapshot().consecutiveFailures).toBe(3)
  })

  it('success from degraded closes the episode with duration and count', () => {
    const log = vi.fn()
    const t = makeOutboundHealthTracker({ log })
    t.recordFailure(T0, 'e1'); t.recordFailure(T1, 'boom')
    t.recordSuccess(T2)
    const s = t.snapshot()
    expect(s.state).toBe('ok')
    expect(s.consecutiveFailures).toBe(0)
    expect(s.lastOkAt).toBe(T2)
    expect(s.episodeStartedAt).toBeNull()
    expect(log).toHaveBeenCalledTimes(2)     // degraded line + recovered line
    expect(log).toHaveBeenLastCalledWith('OUTBOUND', 'recovered after 5m, 2 failures — last error was: boom')
  })

  it('success from unknown/ok logs nothing', () => {
    const log = vi.fn()
    const t = makeOutboundHealthTracker({ log })
    t.recordSuccess(T0)
    t.recordSuccess(T1)
    expect(t.snapshot().state).toBe('ok')
    expect(log).not.toHaveBeenCalled()
  })

  it('failure run below threshold cleared by success does not log', () => {
    const log = vi.fn()
    const t = makeOutboundHealthTracker({ log })
    t.recordFailure(T0, 'e1')
    t.recordSuccess(T1)
    expect(t.snapshot().state).toBe('ok')
    expect(log).not.toHaveBeenCalled()
  })

  it('respects a custom degradedAfter', () => {
    const log = vi.fn()
    const t = makeOutboundHealthTracker({ log, degradedAfter: 1 })
    t.recordFailure(T0, 'e1')
    expect(t.snapshot().state).toBe('degraded')
  })

  it('truncates lastError to 200 chars', () => {
    const t = makeOutboundHealthTracker({ log: () => {} })
    t.recordFailure(T0, 'x'.repeat(500))
    expect(t.snapshot().lastError!.length).toBe(200)
  })

  it('isProactiveWindowClosed: errcode=-2 (prepare failed) is a closed window, not a link failure', () => {
    expect(isProactiveWindowClosed('ilink/sendmessage errcode=-2: prepare failed')).toBe(true)
    expect(isProactiveWindowClosed('errcode=-2')).toBe(true)
    // genuine link failures are NOT window-closed
    expect(isProactiveWindowClosed('Unable to connect. Is the computer able to access the url?')).toBe(false)
    expect(isProactiveWindowClosed('ilink/sendmessage errcode=-6: auth failed')).toBe(false)
    expect(isProactiveWindowClosed('The socket connection was closed unexpectedly')).toBe(false)
  })
})