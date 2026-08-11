import { describe, expect, it, vi } from 'vitest'
import { makeBusySchedule } from './wire-social'

// ─── busy-registry hold (spec 2026-08-11 §2, Task 4 step 4) ────────────────
//
// wire-social.ts wires this wrapper in as the `schedule` injection seam for
// both makeBroker (label 'social-forage') and makeAsyncResponder (label
// 'social-responder') — see their own `schedule?(fn): void` deps. Testing
// the wrapper directly (rather than driving the full wireSocial() setup,
// which needs a live db + registry + a2a client fixture) covers the actual
// behavior change: hold while the background coroutine runs, release once
// it settles either way.
describe('makeBusySchedule', () => {
  it('holds a token for the duration of the scheduled coroutine, released after it resolves', async () => {
    const events: string[] = []
    const release = vi.fn(() => events.push('release'))
    const holdBusy = vi.fn((label: string) => { events.push(`hold:${label}`); return release })
    const schedule = makeBusySchedule('social-forage', holdBusy)

    let resolveFn: () => void = () => {}
    const fn = vi.fn(() => new Promise<void>(resolve => { resolveFn = resolve }))
    schedule(fn)

    // schedule is fire-and-forget — the hold must be visible synchronously,
    // before the caller's own turn even continues, not deferred.
    expect(holdBusy).toHaveBeenCalledTimes(1)
    expect(holdBusy).toHaveBeenCalledWith('social-forage')

    // Let the queued microtask actually invoke fn().
    await Promise.resolve()
    await Promise.resolve()
    expect(fn).toHaveBeenCalledTimes(1)
    expect(release).not.toHaveBeenCalled()

    resolveFn()
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1))
    expect(events).toEqual(['hold:social-forage', 'release'])
  })

  it('releases the token even when the coroutine rejects', async () => {
    const release = vi.fn()
    const holdBusy = vi.fn(() => release)
    const schedule = makeBusySchedule('social-responder', holdBusy)

    const fn = vi.fn(async () => { throw new Error('boom') })
    schedule(fn)

    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1))
  })

  it('is a safe no-op wrapper when holdBusy is absent — fn still runs', async () => {
    const schedule = makeBusySchedule('social-forage', undefined)
    const fn = vi.fn(async () => {})
    schedule(fn)
    await vi.waitFor(() => expect(fn).toHaveBeenCalledTimes(1))
  })

  it('a holdBusy that throws never blocks the coroutine from running (defensive catch)', async () => {
    const holdBusy = vi.fn(() => { throw new Error('registry exploded') })
    const schedule = makeBusySchedule('social-forage', holdBusy)
    const fn = vi.fn(async () => {})
    schedule(fn)
    await vi.waitFor(() => expect(fn).toHaveBeenCalledTimes(1))
  })

  // M2 (code review, 2026-08-11) — this used to be `.catch(() => {})`: a
  // coroutine that threw past its own internal swallow (a bug in forage /
  // the responder's judge+echo+forward loop, or a future caller that
  // doesn't swallow) vanished with zero trace. That silence was also the
  // ONLY way "forage wedged/threw ⇒ busy() stuck true ⇒ self-restart
  // permanently blocked" could ever surface — so it's now logged instead of
  // swallowed.
  it('logs (does not silently swallow) when the scheduled coroutine rejects', async () => {
    const log = vi.fn()
    const schedule = makeBusySchedule('social-forage', undefined, log)
    const fn = vi.fn(async () => { throw new Error('forage wedged') })
    schedule(fn)
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith('SOCIAL_REC', expect.stringContaining('forage wedged')))
    expect(log.mock.calls[0]![1]).toContain('social-forage')
  })

  it('stays silent-safe (no throw) when log is absent — same posture as before this field existed', async () => {
    const schedule = makeBusySchedule('social-forage', undefined, undefined)
    const fn = vi.fn(async () => { throw new Error('boom') })
    // Must not produce an unhandled rejection or throw synchronously.
    expect(() => schedule(fn)).not.toThrow()
    await new Promise(r => setTimeout(r, 0))
  })

  it('a log that itself throws never breaks the wrapper (defensive catch, same posture as holdBusy)', async () => {
    const log = vi.fn(() => { throw new Error('log exploded') })
    const release = vi.fn()
    const holdBusy = vi.fn(() => release)
    const schedule = makeBusySchedule('social-forage', holdBusy, log)
    const fn = vi.fn(async () => { throw new Error('boom') })
    schedule(fn)
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1))
    expect(log).toHaveBeenCalled()
  })
})
