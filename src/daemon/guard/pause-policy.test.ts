import { afterEach, describe, it, expect, vi } from 'vitest'
import { makeExecutorPausePolicy, makeNetworkSuspendController, SUSPEND_CAP_MESSAGE } from './pause-policy'
import { initialState, startGuardScheduler, type GuardState } from './scheduler'

const s = (source: 'bx' | 'probe', safe: boolean): GuardState => ({ ...initialState(), source, safe, reachable: safe, detail: '' })

// 主人 2026-10-03:bx 来源从不停 / 不暂停;probe 来源连续两次不安全 ⇒ 暂停(SIGSTOP),读到安全 ⇒ 放开;
// 暂停 30 分钟(可配)还没恢复 ⇒ 按收工停下并告诉主人;不需要保护的执行者从不动(选择在 workbench 侧,见
// service-network-suspend.test.ts)。
describe('makeExecutorPausePolicy', () => {
  it('bx source: never suspends running executors, however long it stays unsafe', () => {
    const p = makeExecutorPausePolicy()
    for (let i = 0; i < 10; i++) expect(p.observe(s('bx', false))).toBe('none')
    expect(p.suspended).toBe(false)
  })

  it('probe source: suspends on the 2nd consecutive unsafe read, once per unsafe episode; resumes on the first safe read', () => {
    const p = makeExecutorPausePolicy()
    expect(p.observe(s('probe', false))).toBe('none')
    expect(p.observe(s('probe', false))).toBe('suspend')
    expect(p.observe(s('probe', false))).toBe('none')
    expect(p.observe(s('probe', false))).toBe('none')
    expect(p.observe(s('probe', true))).toBe('resume')
    expect(p.observe(s('probe', true))).toBe('none')
    expect(p.observe(s('probe', false))).toBe('none')   // 新的一段,重新数
    expect(p.observe(s('probe', false))).toBe('suspend')
  })

  it('a single probe blip (unsafe then safe) never suspends', () => {
    const p = makeExecutorPausePolicy()
    expect(p.observe(s('probe', false))).toBe('none')
    expect(p.observe(s('probe', true))).toBe('none')
    expect(p.observe(s('probe', false))).toBe('none')
  })

  it('suspended under probe, then the source becomes bx (fail-closed) ⇒ resume, even if bx says unsafe', () => {
    const p = makeExecutorPausePolicy()
    p.observe(s('probe', false)); expect(p.observe(s('probe', false))).toBe('suspend')
    expect(p.observe(s('bx', false))).toBe('resume')
    expect(p.observe(s('bx', false))).toBe('none')
  })
})

describe('makeNetworkSuspendController (fake clock)', () => {
  afterEach(() => { vi.useRealTimers() })
  function make(over: Partial<Parameters<typeof makeNetworkSuspendController>[0]> = {}) {
    const deps = { suspend: vi.fn(), resume: vi.fn(), stopSuspended: vi.fn(), maxSuspendMs: () => 30 * 60_000, log: vi.fn(), ...over }
    return { deps, c: makeNetworkSuspendController(deps) }
  }

  it('bx never suspends', () => {
    const { deps, c } = make()
    for (let i = 0; i < 5; i++) c.observe(s('bx', false))
    expect(deps.suspend).not.toHaveBeenCalled()
  })

  it('probe: suspend after 2 consecutive unsafe; resume on safe; no stop', () => {
    vi.useFakeTimers()
    const { deps, c } = make()
    c.observe(s('probe', false)); expect(deps.suspend).not.toHaveBeenCalled()
    c.observe(s('probe', false)); expect(deps.suspend).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(29 * 60_000)
    c.observe(s('probe', true))
    expect(deps.resume).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(60 * 60_000)
    expect(deps.stopSuspended).not.toHaveBeenCalled()
  })

  it('30-minute cap ⇒ graceful stop with the owner sentence, exactly once; a later safe read is harmless', () => {
    vi.useFakeTimers()
    const { deps, c } = make()
    c.observe(s('probe', false)); c.observe(s('probe', false))
    vi.advanceTimersByTime(30 * 60_000 - 1); expect(deps.stopSuspended).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(deps.stopSuspended).toHaveBeenCalledWith(SUSPEND_CAP_MESSAGE)
    expect(SUSPEND_CAP_MESSAGE).toBe('网络一直没恢复，任务已停止，可以接着做')
    c.observe(s('probe', false))
    expect(deps.suspend).toHaveBeenCalledTimes(1)          // 同一段不安全期不再冻第二次
    vi.advanceTimersByTime(60 * 60_000)
    expect(deps.stopSuspended).toHaveBeenCalledTimes(1)
    c.observe(s('probe', true))
    expect(deps.resume).toHaveBeenCalledTimes(1)
  })

  it('cap is configurable (guard.json max_suspend_minutes)', () => {
    vi.useFakeTimers()
    const { deps, c } = make({ maxSuspendMs: () => 5 * 60_000 })
    c.observe(s('probe', false)); c.observe(s('probe', false))
    vi.advanceTimersByTime(5 * 60_000)
    expect(deps.stopSuspended).toHaveBeenCalledTimes(1)
  })

  it('guard switched off while suspended ⇒ resume (off means judge nothing)', () => {
    vi.useFakeTimers()
    let enabled = true
    const { deps, c } = make({ isEnabled: () => enabled, enabledPollMs: 1000 })
    c.observe(s('probe', false)); c.observe(s('probe', false))
    enabled = false
    vi.advanceTimersByTime(1000)
    expect(deps.resume).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(60 * 60_000)
    expect(deps.stopSuspended).not.toHaveBeenCalled()
  })
})

// 与 wiring/lifecycle-deps.ts 同一接法:scheduler.onReading → controller → workbench。
describe('scheduler + suspend controller (as wired in lifecycle-deps)', () => {
  function wire(over: Parameters<typeof startGuardScheduler>[0] extends infer D ? Partial<D> : never) {
    const suspend = vi.fn(), resume = vi.fn()
    const c = makeNetworkSuspendController({ suspend, resume, stopSuspended: vi.fn(), maxSuspendMs: () => 30 * 60_000, log: () => {} })
    const sched = startGuardScheduler({
      pollMs: 1_000_000, isEnabled: () => true, probeUrl: () => 'https://canary.test/204', ipifyUrl: () => 'https://ipify.test',
      fetchPublicIp: async () => ({ ip: '1.2.3.4' }),
      onReading: (st) => c.observe(st),
      ...over,
    })
    return { sched, suspend, resume, c }
  }

  it('bx unsafe for many ticks → running executors are NOT suspended', async () => {
    const { sched, suspend, c } = wire({ findBx: () => '/fake/bx', readBx: async () => ({ safe: false, protection: 'recovering', tunnelHealthy: false, detail: 'bx 未保护(protection_state=recovering)' }) })
    for (let i = 0; i < 5; i++) await sched.pokeNow()
    expect(sched.current().safe).toBe(false)
    expect(suspend).not.toHaveBeenCalled()
    await sched.stop(); c.dispose()
  })

  it('probe down → suspended after 2 unsafe reads (once); probe back up → resumed', async () => {
    let up = false
    const probe = vi.fn(async () => ({ reachable: up, ms: up ? 1 : null, ...(up ? {} : { error: 'timeout' }) }))
    const { sched, suspend, resume, c } = wire({ findBx: () => null, probeReachable: probe })
    await sched.pokeNow()
    expect(suspend).not.toHaveBeenCalled()
    await sched.pokeNow()
    expect(suspend).toHaveBeenCalledTimes(1)
    await sched.pokeNow()
    expect(suspend).toHaveBeenCalledTimes(1)
    up = true
    await sched.pokeNow()
    expect(resume).toHaveBeenCalledTimes(1)
    await sched.stop(); c.dispose()
  })

  it('probe recovers without an IP change (re-probe while down)', async () => {
    let up = false
    const { sched, c } = wire({ findBx: () => null, probeReachable: async () => ({ reachable: up, ms: 1 }) })
    await sched.pokeNow()
    expect(sched.current().reachable).toBe(false)
    up = true
    await sched.pokeNow()
    expect(sched.current().reachable).toBe(true)
    await sched.stop(); c.dispose()
  })
})
