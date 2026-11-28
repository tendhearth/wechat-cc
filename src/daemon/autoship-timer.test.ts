import { describe, expect, it, vi } from 'vitest'
import { makeAutoshipTick } from './autoship-timer'

const ms = (minutes: number) => minutes * 60_000

describe('autoship timer', () => {
  it.each([
    [undefined, 20],
    [30, 30],
    [1, 5],
    [0, 5],
    [Infinity, 20],
  ])('interval %s starts at minute %s and repeats', (configured, first) => {
    let now = 0
    const start = vi.fn(() => undefined)
    const tick = makeAutoshipTick({ now: () => now, settings: () => ({ auto_ship: true, auto_ship_interval_min: configured }), start })
    for (const time of [0, ms(5) - 1, ms(first) - 1]) {
      now = time
      tick()
      expect(start).not.toHaveBeenCalled()
    }
    now = ms(first)
    tick()
    expect(start).toHaveBeenCalledTimes(1)
    tick()
    now = ms(first * 2) - 1
    tick()
    expect(start).toHaveBeenCalledTimes(1)
    now = ms(first * 2)
    tick()
    expect(start).toHaveBeenCalledTimes(2)
  })

  it('loads changes on the next tick and never starts while disabled', () => {
    let now = 0
    let enabled: boolean | undefined
    const start = vi.fn(() => undefined)
    const tick = makeAutoshipTick({ now: () => now, settings: () => ({ auto_ship: enabled }), start })
    now = ms(21)
    tick()
    expect(start).not.toHaveBeenCalled()
    enabled = true
    tick()
    expect(start).toHaveBeenCalledTimes(1)
    enabled = false
    now = ms(60)
    tick()
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('does not start another round until its detached child exits', () => {
    let now = 0
    let alive = true
    const start = vi.fn(() => () => alive)
    const tick = makeAutoshipTick({ now: () => now, settings: () => ({ auto_ship: true }), start })
    now = ms(20)
    tick()
    now = ms(80)
    tick()
    expect(start).toHaveBeenCalledOnce()
    alive = false
    tick()
    expect(start).toHaveBeenCalledTimes(2)
  })

})
