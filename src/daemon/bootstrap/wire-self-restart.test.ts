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
// `readHead`/`readLockBlob` are fake here (code review #3 on Task 6) — same
// injection-seam shape/posture as `SelfRestartDeps.readHead`/`readLockBlob`
// in `../self-restart/wire.ts` (default to the real git implementation;
// production wiring in bootstrap/index.ts never overrides them). Faking
// them makes every assertion below deterministic regardless of whether the
// test environment has a working git checkout — the tests below want to
// prove `busy()`/`lastPollSuccessAgoMs()` gate the outcome, not that git
// happens to be present.
const fakeHead = () => 'a'.repeat(40)

describe('wireSelfRestart', () => {
  it('returns null when requestRestart is absent — mechanism fully inert (no git read either)', async () => {
    const readHead = vi.fn()
    const wired = await wireSelfRestart({
      anyInFlight: () => false,
      busy: () => false,
      lastPollSuccessAgoMs: () => null,
      log: () => {},
      readHead,
    })
    expect(wired).toBeNull()
    expect(readHead).not.toHaveBeenCalled()
  })

  it('returns a callable check + a real activity marker when requestRestart is provided', async () => {
    const wired = await wireSelfRestart({
      requestRestart: () => {},
      anyInFlight: () => false,
      busy: () => false,
      lastPollSuccessAgoMs: () => null,
      log: () => {},
      readHead: async () => fakeHead(),
      readLockBlob: async () => 'lockblob',
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
      readHead: async () => fakeHead(),
      readLockBlob: async () => 'lockblob',
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
      readHead: async () => fakeHead(),
      readLockBlob: async () => 'lockblob',
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
      readHead: async () => fakeHead(),
      readLockBlob: async () => 'lockblob',
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
      readHead: async () => fakeHead(),
      readLockBlob: async () => 'lockblob',
    })
    expect(wired).not.toBeNull()
    clock += 300_001
    await expect(wired!.check()).resolves.toBeUndefined()
  })

  it('readLockBlob is skipped entirely when readHead resolves null (boot-time short-circuit, Task 3 review #2 posture preserved)', async () => {
    const readLockBlob = vi.fn(async () => 'lockblob')
    const wired = await wireSelfRestart({
      requestRestart: () => {},
      anyInFlight: () => false,
      busy: () => false,
      lastPollSuccessAgoMs: () => 0,
      log: () => {},
      readHead: async () => null,
      readLockBlob,
    })
    expect(wired).not.toBeNull()
    expect(readLockBlob).not.toHaveBeenCalled()
    // loadedHead === null ⇒ check() must be a permanent no-op regardless of
    // how idle/fresh everything else looks.
    await wired!.check()
  })
})
