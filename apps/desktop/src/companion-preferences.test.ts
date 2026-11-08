import { describe, expect, it, vi } from 'vitest'
import { createCompanionPreferences, MOTION_STORAGE_KEY, QUIET_MS } from './companion-preferences.js'

function setup(raw: string | null = null) {
  let now = 1000
  let monotonic = 0
  let stored = raw
  const timers = new Map<number, { fn: () => void, ms: number }>()
  let seq = 0
  const changed = vi.fn()
  const p = createCompanionPreferences({
    storage: { getItem: () => stored, setItem: (_, v) => { stored = v } },
    now: () => now, monotonicNow: () => monotonic, schedule: (fn, ms) => { timers.set(++seq, { fn, ms }); return seq }, cancel: h => { timers.delete(h as number) },
    onChange: changed,
  })
  return { p, timers, changed, stored: () => stored, moveWall(ms: number) { now += ms }, elapse(ms: number) { now += ms; monotonic += ms }, advance(ms: number) { now += ms; monotonic += ms; const due = [...timers.values()]; timers.clear(); due.forEach(t => t.fn()) } }
}

describe('companion motion preferences', () => {
  it('system reduction wins live while the explicit user choice persists', () => {
    const { p, stored } = setup()
    p.setSystemReduced(true)
    p.setUserReduced(false)
    expect(p.snapshot()).toMatchObject({ reducedMotion: true, userReduced: false })
    p.setSystemReduced(false)
    expect(p.snapshot().reducedMotion).toBe(false)
    p.setUserReduced(true)
    expect(JSON.parse(stored()!)).toMatchObject({ userReduced: true })
    p.setSystemReduced(true); p.setSystemReduced(false)
    expect(p.snapshot().reducedMotion).toBe(true)
    p.destroy()
  })
  it('quiet lasts one hour, persists its deadline, and expires without adding time', () => {
    const { p, timers, stored, advance, changed } = setup()
    p.setQuiet(true)
    expect(p.snapshot()).toMatchObject({ quiet: true, quietUntil: 1000 + QUIET_MS })
    expect([...timers.values()][0]!.ms).toBe(QUIET_MS)
    const reboot = setup(stored())
    expect(reboot.p.snapshot().quiet).toBe(true)
    advance(QUIET_MS)
    expect(p.snapshot()).toMatchObject({ quiet: false, quietUntil: 0 })
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ quiet: false }))
    expect(JSON.parse(stored()!).quietUntil).toBe(0)
    p.destroy(); reboot.p.destroy()
  })
  it.each(['oops', 'null', '[]', '{"userReduced":"yes","quietUntil":99999999999999}', '{"quietUntil":-2}', '{"quietUntil":"9000"}'])('ignores malformed or unbounded values: %s', raw => {
    const { p } = setup(raw)
    expect(p.snapshot()).toMatchObject({ userReduced: false, quiet: false })
    p.destroy()
  })
  it('destroy prevents a later snapshot refresh or already queued timeout from rearming quiet', () => {
    const { p, timers, changed } = setup()
    p.setQuiet(true)
    const callback = [...timers.values()][0]!.fn
    p.destroy(); p.refresh(); callback()
    expect(timers.size).toBe(0)
    expect(changed).toHaveBeenCalledTimes(1)
  })
  it('expired persisted quiet remains off and storage failure still permits controls', () => {
    expect(setup('{"quietUntil":900}').p.snapshot().quiet).toBe(false)
    const p = createCompanionPreferences({ storage: { getItem() { throw Error('denied') }, setItem() { throw Error('denied') } } })
    expect(() => { p.setUserReduced(true); p.setQuiet(true); p.setQuiet(false) }).not.toThrow()
    expect(p.snapshot()).toMatchObject({ userReduced: true, quiet: false })
    expect(MOTION_STORAGE_KEY).toBeTypeOf('string')
    p.destroy()
  })
})

describe('quiet ends at the earlier wall or elapsed deadline', () => {
  it.each([QUIET_MS, 30 * 24 * QUIET_MS])('rollback by %i ms cannot extend quiet or overflow the next timer', rollback => {
    const { p, timers, changed, moveWall, elapse, advance } = setup()
    p.setQuiet(true)
    elapse(QUIET_MS / 2)
    moveWall(-rollback)
    p.refresh()
    expect(p.snapshot().quiet).toBe(true)
    expect([...timers.values()].map(t => t.ms)).toEqual([QUIET_MS / 2])
    advance(QUIET_MS / 2)
    expect(p.snapshot()).toMatchObject({ quiet: false, quietUntil: 0 })
    expect(timers.size).toBe(0)
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ quiet: false }))
    p.destroy()
  })
  it('an original timer callback after rollback expires instead of scheduling an oversized delay', () => {
    const { p, timers, stored, moveWall, advance } = setup()
    p.setQuiet(true)
    moveWall(-30 * 24 * QUIET_MS)
    advance(QUIET_MS)
    expect(p.snapshot().quiet).toBe(false)
    expect(timers.size).toBe(0)
    expect(JSON.parse(stored()!).quietUntil).toBe(0)
    p.destroy()
  })
  it('a persisted quiet period also uses monotonic time after it is loaded', () => {
    const { p, timers, moveWall, advance } = setup(JSON.stringify({ quietUntil: 1000 + QUIET_MS / 2 }))
    moveWall(-30 * 24 * QUIET_MS)
    advance(QUIET_MS / 2)
    expect(p.snapshot().quiet).toBe(false)
    expect(timers.size).toBe(0)
    p.destroy()
  })
  it.each([QUIET_MS, 30 * 24 * QUIET_MS])('wall advancing %i ms expires quiet even while monotonic time is suspended', elapsed => {
    const { p, timers, stored, changed, moveWall } = setup()
    p.setQuiet(true)
    moveWall(elapsed)
    p.refresh(); p.refresh(); p.refresh()
    expect(p.snapshot()).toMatchObject({ quiet: false, quietUntil: 0 })
    expect(timers.size).toBe(0)
    expect(JSON.parse(stored()!).quietUntil).toBe(0)
    expect(changed.mock.calls.filter(([s]) => !s.quiet)).toHaveLength(1)
    p.destroy()
  })
  it('a loaded quiet deadline also expires after suspend without waiting for elapsed time', () => {
    const { p, timers, moveWall } = setup(JSON.stringify({ quietUntil: 1000 + QUIET_MS / 2 }))
    moveWall(QUIET_MS / 2)
    p.refresh()
    expect(p.snapshot().quiet).toBe(false)
    expect(timers.size).toBe(0)
    p.destroy()
  })
  it('partial suspend reduces remaining time and saves the original wall deadline', () => {
    const { p, timers, stored, moveWall, advance } = setup()
    p.setQuiet(true)
    moveWall(QUIET_MS / 2)
    p.refresh()
    expect(p.snapshot()).toMatchObject({ quiet: true, quietUntil: 1000 + QUIET_MS })
    expect([...timers.values()].map(t => t.ms)).toEqual([QUIET_MS / 2])
    p.setUserReduced(true)
    expect(JSON.parse(stored()!).quietUntil).toBe(1000 + QUIET_MS)
    advance(QUIET_MS / 2)
    expect(p.snapshot().quiet).toBe(false)
    p.destroy()
  })
  it('saving during rollback projects only the bounded elapsed remainder for reload', () => {
    const { p, stored, moveWall, elapse, timers } = setup()
    p.setQuiet(true)
    elapse(QUIET_MS / 2); moveWall(-30 * 24 * QUIET_MS)
    p.setUserReduced(true)
    const saved = JSON.parse(stored()!).quietUntil
    expect(saved).toBe(1000 - 30 * 24 * QUIET_MS + QUIET_MS)
    expect(saved).toBeLessThan(1000 + QUIET_MS)
    p.destroy()
    expect(timers.size).toBe(0)
  })
})
