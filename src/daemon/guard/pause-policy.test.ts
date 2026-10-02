import { describe, it, expect, vi } from 'vitest'
import { makeExecutorPausePolicy } from './pause-policy'
import { initialState, startGuardScheduler, type GuardState } from './scheduler'

const s = (source: 'bx' | 'probe', safe: boolean): GuardState => ({ ...initialState(), source, safe, reachable: safe, detail: '' })

describe('makeExecutorPausePolicy', () => {
  it('bx source: never pauses running executors, however long it stays unsafe', () => {
    const p = makeExecutorPausePolicy()
    for (let i = 0; i < 10; i++) expect(p.observe(s('bx', false))).toBe(false)
  })

  it('probe source: pauses on the 2nd consecutive unsafe read, once per unsafe episode', () => {
    const p = makeExecutorPausePolicy()
    expect(p.observe(s('probe', false))).toBe(false)
    expect(p.observe(s('probe', false))).toBe(true)
    expect(p.observe(s('probe', false))).toBe(false)
    expect(p.observe(s('probe', true))).toBe(false)
    expect(p.observe(s('probe', false))).toBe(false)   // 新的一段,重新数
    expect(p.observe(s('probe', false))).toBe(true)
  })

  it('a single probe blip (unsafe then safe) never pauses', () => {
    const p = makeExecutorPausePolicy()
    expect(p.observe(s('probe', false))).toBe(false)
    expect(p.observe(s('probe', true))).toBe(false)
    expect(p.observe(s('probe', false))).toBe(false)
  })
})

// 与 wiring/lifecycle-deps.ts 同一接法:scheduler.onReading → policy → pauseForNetwork。
describe('scheduler + pause policy (as wired in lifecycle-deps)', () => {
  function wire(over: Parameters<typeof startGuardScheduler>[0] extends infer D ? Partial<D> : never) {
    const pause = vi.fn(() => 1)
    const policy = makeExecutorPausePolicy()
    const sched = startGuardScheduler({
      pollMs: 1_000_000, isEnabled: () => true, probeUrl: () => 'https://canary.test/204', ipifyUrl: () => 'https://ipify.test',
      fetchPublicIp: async () => ({ ip: '1.2.3.4' }),
      onReading: (st) => { if (policy.observe(st)) pause() },
      ...over,
    })
    return { sched, pause }
  }

  it('bx unsafe for many ticks → running executors are NOT paused', async () => {
    const { sched, pause } = wire({ findBx: () => '/fake/bx', readBx: async () => ({ safe: false, protection: 'recovering', tunnelHealthy: false, detail: 'bx 未保护(protection_state=recovering)' }) })
    for (let i = 0; i < 5; i++) await sched.pokeNow()
    expect(sched.current().safe).toBe(false)
    expect(pause).not.toHaveBeenCalled()
    await sched.stop()
  })

  it('probe down → re-probed every tick while down (same IP); paused only after 2 unsafe reads', async () => {
    const probe = vi.fn(async () => ({ reachable: false, ms: null, error: 'timeout' }))
    const { sched, pause } = wire({ findBx: () => null, probeReachable: probe })
    await sched.pokeNow()
    expect(pause).not.toHaveBeenCalled()
    await sched.pokeNow()
    expect(probe).toHaveBeenCalledTimes(2)
    expect(pause).toHaveBeenCalledTimes(1)
    await sched.pokeNow()
    expect(pause).toHaveBeenCalledTimes(1)
    await sched.stop()
  })

  it('probe recovers without an IP change (re-probe while down)', async () => {
    let up = false
    const { sched } = wire({ findBx: () => null, probeReachable: async () => ({ reachable: up, ms: 1 }) })
    await sched.pokeNow()
    expect(sched.current().reachable).toBe(false)
    up = true
    await sched.pokeNow()
    expect(sched.current().reachable).toBe(true)
    await sched.stop()
  })
})
