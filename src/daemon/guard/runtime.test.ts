import { describe, it, expect, vi } from 'vitest'
import { makeGuardRuntime } from './runtime'
import { initialState, type GuardState } from './scheduler'
import type { GuardLifecycle } from './lifecycle'

const SAFE_BX = { safe: true, protection: 'protected', tunnelHealthy: true, detail: 'bx 保护中' }
const DOWN_BX = { safe: false, protection: 'off', tunnelHealthy: false, detail: 'bx 未保护(protection_state=off)' }

function rt(over: { enabled?: boolean; bx?: string | null; read?: typeof SAFE_BX | typeof DOWN_BX } = {}) {
  const log = vi.fn()
  const readBx = vi.fn(async () => over.read ?? SAFE_BX)
  const r = makeGuardRuntime({
    stateDir: '/nonexistent',
    log,
    isEnabled: () => over.enabled ?? true,
    findBx: () => (over.bx === undefined ? '/fake/bx' : over.bx),
    readBx,
  })
  return { r, log, readBx }
}

function lifecycleWith(state: GuardState): GuardLifecycle {
  return { name: 'guard', stop: async () => {}, current: () => state, pokeNow: async () => state }
}

describe('makeGuardRuntime', () => {
  it('skipWhenUnsafe: unsafe → job never runs, one log line per unsafe episode, no throw', async () => {
    const { r, log } = rt({ read: DOWN_BX })
    const job = vi.fn(async () => {})
    const wrapped = r.skipWhenUnsafe('companion.push', job)
    await wrapped(); await wrapped(); await wrapped()
    expect(job).not.toHaveBeenCalled()
    expect(log.mock.calls.filter(c => String(c[1]).includes('companion.push: skipped'))).toHaveLength(1)
  })

  it('skipWhenUnsafe: safe → runs the job; recovery is logged once', async () => {
    let read = DOWN_BX as typeof SAFE_BX | typeof DOWN_BX
    const log = vi.fn()
    const r = makeGuardRuntime({ stateDir: '/x', log, isEnabled: () => true, findBx: () => '/fake/bx', readBx: async () => read })
    const job = vi.fn(async () => {})
    const wrapped = r.skipWhenUnsafe('companion.ingest', job)
    await wrapped()
    expect(job).not.toHaveBeenCalled()
    read = SAFE_BX
    // 闸门的当场读数有 5s 短缓存;用调度器的新鲜读数顶替
    r.ref.set(lifecycleWith({ ...initialState(), source: 'bx', safe: true, reachable: true, detail: 'bx 保护中', lastChecked: new Date().toISOString() }))
    await wrapped()
    expect(job).toHaveBeenCalledTimes(1)
    expect(log.mock.calls.some(c => String(c[1]).includes('resuming'))).toBe(true)
  })

  it('guard disabled → gate always safe, background jobs run, health says off', async () => {
    const { r, readBx } = rt({ enabled: false, read: DOWN_BX })
    const job = vi.fn(async () => {})
    await r.skipWhenUnsafe('x', job)()
    expect(job).toHaveBeenCalled()
    expect(readBx).not.toHaveBeenCalled()
    expect(r.health()).toEqual(expect.objectContaining({ enabled: false, source: 'off', safe: true }))
  })

  it('health mirrors the scheduler state once it has run', () => {
    const { r } = rt()
    r.ref.set(lifecycleWith({ ...initialState(), source: 'bx', safe: false, reachable: false, detail: 'bx 隧道不健康(tunnel_healthy=false)', ip: '9.9.9.9', lastChecked: '2026-10-02T10:00:00.000Z' }))
    expect(r.health()).toEqual({ enabled: true, source: 'bx', safe: false, detail: 'bx 隧道不健康(tunnel_healthy=false)', ip: '9.9.9.9', checked_at: '2026-10-02T10:00:00.000Z' })
  })

  it('health before the scheduler ran falls back to the last gate verdict (fail-closed reading visible)', async () => {
    const { r } = rt({ read: DOWN_BX })
    await r.gate.check()
    expect(r.health()).toEqual(expect.objectContaining({ enabled: true, source: 'bx', safe: false }))
  })
})
