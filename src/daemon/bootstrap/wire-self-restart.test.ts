import { describe, expect, it, vi } from 'vitest'
import { wireSelfRestart } from './wire-self-restart'

// ─── self-restart assembly (spec 2026-08-03 / 2026-08-11 §4/§5, Task 6) ────
//
// Task 3 wired makeSelfRestartCheck to a safe placeholder (`busy: () =>
// false`, `lastPollSuccessAgoMs: () => null`) so the mechanism never fired
// on stale signals. Task 6's job is replacing that placeholder with the
// REAL busy-registry + poll-freshness reads (done in bootstrap/index.ts) —
// these tests pin down that wireSelfRestart actually threads whatever
// `busy`/`lastPollSuccessAgoMs` it's given through to the returned check,
// rather than silently keeping the old TEMP behavior.
//
// No mocking of git (readGitHead/readGitLockfileBlob) — same posture as
// bootstrap.test.ts's own self-restart test: real, read-only, offline,
// ~10ms in a checkout. `now` IS injectable (unlike the git reads), which is
// what lets these tests bypass the 5-minute BOOT_GRACE_MS window without
// a real sleep.
describe('wireSelfRestart', () => {
  it('returns null when requestRestart is absent — mechanism fully inert', async () => {
    const wired = await wireSelfRestart({
      anyInFlight: () => false,
      busy: () => false,
      lastPollSuccessAgoMs: () => null,
      log: () => {},
    })
    expect(wired).toBeNull()
  })

  it('returns a callable check + a real activity marker when requestRestart is provided', async () => {
    const wired = await wireSelfRestart({
      requestRestart: () => {},
      anyInFlight: () => false,
      busy: () => false,
      lastPollSuccessAgoMs: () => null,
      log: () => {},
    })
    expect(wired).not.toBeNull()
    expect(typeof wired!.check).toBe('function')
    expect(typeof wired!.marker.mark).toBe('function')
    expect(typeof wired!.marker.quietFor).toBe('function')
    // Never invoked mark() ⇒ quietFor reports "very quiet" (Infinity) — the
    // SAME instance backs Bootstrap['markInboundActivity'], so this also
    // pins that the marker returned here is live, not a dead stand-in.
    expect(wired!.marker.quietFor(Date.now())).toBe(Number.POSITIVE_INFINITY)
  })

  it('busy()=true blocks a restart even once the boot-grace window has passed and poll is fresh — proves busy() is the REAL signal, not the Task-3 always-false placeholder', async () => {
    let clock = 1_000_000
    const now = () => clock
    const busy = vi.fn(() => true)
    const lastPollSuccessAgoMs = vi.fn(() => 0) // fresh: 0ms since last success
    const requestRestart = vi.fn()

    const wired = await wireSelfRestart({
      requestRestart,
      anyInFlight: () => false,
      busy,
      lastPollSuccessAgoMs,
      log: () => {},
      now,
    })
    expect(wired).not.toBeNull()

    clock += 300_001 // past BOOT_GRACE_MS (300_000ms)
    await wired!.check()

    expect(busy).toHaveBeenCalled()
    expect(requestRestart).not.toHaveBeenCalled()
  })

  it('lastPollSuccessAgoMs()=null blocks a restart even when idle otherwise — proves poll-freshness is the REAL signal, not the Task-3 always-null placeholder', async () => {
    let clock = 2_000_000
    const now = () => clock
    const busy = vi.fn(() => false)
    const lastPollSuccessAgoMs = vi.fn(() => null)
    const requestRestart = vi.fn()

    const wired = await wireSelfRestart({
      requestRestart,
      anyInFlight: () => false,
      busy,
      lastPollSuccessAgoMs,
      log: () => {},
      now,
    })
    expect(wired).not.toBeNull()

    clock += 300_001
    await wired!.check()

    expect(lastPollSuccessAgoMs).toHaveBeenCalled()
    expect(requestRestart).not.toHaveBeenCalled()
  })

  it('a stale poll (lastPollSuccessAgoMs beyond POLL_FRESH_MS) blocks a restart the same way null does', async () => {
    let clock = 3_000_000
    const now = () => clock
    const lastPollSuccessAgoMs = vi.fn(() => 999_999) // way beyond POLL_FRESH_MS (120_000)
    const requestRestart = vi.fn()

    const wired = await wireSelfRestart({
      requestRestart,
      anyInFlight: () => false,
      busy: () => false,
      lastPollSuccessAgoMs,
      log: () => {},
      now,
    })
    expect(wired).not.toBeNull()

    clock += 300_001
    await wired!.check()

    expect(lastPollSuccessAgoMs).toHaveBeenCalled()
    expect(requestRestart).not.toHaveBeenCalled()
  })

  it('check() never throws even when busy() throws (defensive catch — self-restart must never become a new failure source)', async () => {
    let clock = 4_000_000
    const now = () => clock
    const wired = await wireSelfRestart({
      requestRestart: () => {},
      anyInFlight: () => false,
      busy: () => { throw new Error('registry exploded') },
      lastPollSuccessAgoMs: () => 0,
      log: () => {},
      now,
    })
    expect(wired).not.toBeNull()
    clock += 300_001
    await expect(wired!.check()).resolves.toBeUndefined()
  })
})
