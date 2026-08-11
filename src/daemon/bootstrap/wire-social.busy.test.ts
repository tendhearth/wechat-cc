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
})
