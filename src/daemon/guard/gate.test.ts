import { describe, it, expect, vi } from 'vitest'
import { createNetworkGate, type NetworkGateDeps } from './gate'
import { initialState, type GuardState } from './scheduler'
import { assertCallAllowed, isNetworkUnprotectedError, unprotectedMessage } from '../../lib/network-gate'

const SAFE_BX = { safe: true, protection: 'protected', tunnelHealthy: true, detail: 'bx 保护中' }
const DOWN_BX = { safe: false, protection: null, tunnelHealthy: null, detail: 'bx 没在运行或读不出状态(exit 1)' }

function bxState(safe: boolean, at: number): GuardState {
  return { ...initialState(), source: 'bx', safe, reachable: safe, detail: safe ? 'bx 保护中' : 'bx 未保护', lastChecked: new Date(at).toISOString() }
}

function deps(over: Partial<NetworkGateDeps> = {}): NetworkGateDeps {
  return {
    isEnabled: () => true,
    current: () => null,
    findBx: () => '/fake/bx',
    readBx: async () => SAFE_BX,
    now: () => 1_000_000,
    ...over,
  }
}

describe('createNetworkGate', () => {
  it('disabled → always safe (source=off), never touches bx', async () => {
    const readBx = vi.fn(async () => DOWN_BX)
    const g = createNetworkGate(deps({ isEnabled: () => false, readBx }))
    expect(await g.check()).toEqual(expect.objectContaining({ safe: true, source: 'off' }))
    expect(readBx).not.toHaveBeenCalled()
  })

  it('bx installed + fresh scheduler reading → uses it without exec', async () => {
    const readBx = vi.fn(async () => SAFE_BX)
    const g = createNetworkGate(deps({ current: () => bxState(false, 1_000_000 - 5_000), readBx }))
    expect(await g.check()).toEqual({ safe: false, source: 'bx', detail: 'bx 未保护' })
    expect(readBx).not.toHaveBeenCalled()
  })

  it('bx installed but no scheduler yet → reads bx on demand (fail closed when unreadable)', async () => {
    const g = createNetworkGate(deps({ readBx: async () => DOWN_BX }))
    const v = await g.check()
    expect(v.safe).toBe(false)
    expect(v.source).toBe('bx')
  })

  it('bx installed + stale scheduler reading → re-reads; readBx throwing → unsafe', async () => {
    const g = createNetworkGate(deps({ current: () => bxState(true, 0), readBx: async () => { throw new Error('boom') } }))
    const v = await g.check()
    expect(v.safe).toBe(false)
    expect(v.detail).toContain('boom')
  })

  it('on-demand bx reads are single-flight and briefly cached (no exec storm)', async () => {
    const readBx = vi.fn(async () => SAFE_BX)
    const g = createNetworkGate(deps({ readBx }))
    await Promise.all([g.check(), g.check(), g.check()])
    await g.check()
    expect(readBx).toHaveBeenCalledTimes(1)
  })

  it('bx not installed → probe semantics (reachable); no bx fallback', async () => {
    const readBx = vi.fn(async () => DOWN_BX)
    const g = createNetworkGate(deps({ findBx: () => null, readBx, current: () => ({ ...initialState(), reachable: false, safe: false, detail: '探测失败', lastChecked: new Date(1_000_000).toISOString() }) }))
    expect(await g.check()).toEqual({ safe: false, source: 'probe', detail: '探测失败' })
    expect(readBx).not.toHaveBeenCalled()
  })

  it('fail-open fixed: no bx + no probe result yet → waits (bounded) then UNSAFE — never the v1 initial "reachable"', async () => {
    const g = createNetworkGate(deps({ findBx: () => null, firstProbeWaitMs: 20 }))
    const v = await g.check()
    expect(v).toMatchObject({ safe: false, source: 'probe' })
    expect(v.detail).toContain('还没拿到')
    // 调度器刚起、头一拍还没探:等它那一拍
    let resolve!: (s: GuardState) => void
    const tick = new Promise<GuardState>(r => { resolve = r })
    const g2 = createNetworkGate(deps({ findBx: () => null, current: () => initialState(), pokeNow: () => tick, firstProbeWaitMs: 1_000 }))
    const p = g2.check()
    resolve({ ...initialState(), source: 'probe', reachable: true, safe: true, detail: '探测可达', lastChecked: new Date().toISOString() })
    expect((await p).safe).toBe(true)
  })

  it('first-probe waits are single-flight (no probe storm)', async () => {
    const probeOnce = vi.fn(async () => ({ reachable: true }))
    const g = createNetworkGate(deps({ findBx: () => null, probeOnce }))
    await Promise.all([g.check(), g.check(), g.check()])
    await g.check()
    expect(probeOnce).toHaveBeenCalledTimes(1)
  })
})

describe('assertCallAllowed', () => {
  const CLAUDE = { provider: 'claude', purpose: 'turn' as const }
  it('protected call + unsafe → NetworkUnprotectedError naming what was paused (one consistent text)', async () => {
    const g = createNetworkGate(deps({ readBx: async () => DOWN_BX }))
    const err = await assertCallAllowed(g, CLAUDE).catch((e: unknown) => e) as Error
    expect(isNetworkUnprotectedError(err)).toBe(true)
    expect(err.message).toBe(unprotectedMessage({ source: 'bx' }, 'Claude'))
    expect(err.message).toBe('网络未受保护(bx 未连上),用到 Claude 的这一步先暂停，恢复后再试。')
  })

  it('a throwing gate is treated as unsafe for protected calls', async () => {
    const err = await assertCallAllowed({ check: async () => { throw new Error('x') } }, CLAUDE).catch((e: unknown) => e)
    expect(isNetworkUnprotectedError(err)).toBe(true)
  })

  it('unprotected call never reads the signal, even from a throwing gate', async () => {
    const check = vi.fn(async () => { throw new Error('x') })
    await expect(assertCallAllowed({ check }, { provider: 'openai', baseUrl: 'https://api.deepseek.com' })).resolves.toBeUndefined()
    expect(check).not.toHaveBeenCalled()
  })

  it('no gate / safe gate → resolves', async () => {
    await expect(assertCallAllowed(undefined, CLAUDE)).resolves.toBeUndefined()
    await expect(assertCallAllowed(createNetworkGate(deps()), CLAUDE)).resolves.toBeUndefined()
  })
})

// 评审 #193 P1-2:过期的探测结果按「不知道」处理 —— 要先拿到新结果,拿不到按不安全。
describe('probe result freshness (review #193 P1)', () => {
  const probeState = (safe: boolean, at: number): GuardState => ({ ...initialState(), source: 'probe', safe, reachable: safe, detail: safe ? '探测可达' : '探测失败', lastChecked: new Date(at).toISOString() })

  it('an expired probe result is not trusted — re-polls; no fresh result → unsafe', async () => {
    const stale = probeState(true, 0)
    const g = createNetworkGate(deps({ findBx: () => null, current: () => stale, pokeNow: () => Promise.resolve(stale), probeStaleMs: 60_000, firstProbeWaitMs: 10 }))
    const v = await g.check()
    expect(v.safe).toBe(false)
    expect(v.source).toBe('probe')
  })

  it('a fresh probe result is used as-is', async () => {
    const g = createNetworkGate(deps({ findBx: () => null, current: () => probeState(true, 1_000_000 - 1_000), probeStaleMs: 60_000 }))
    expect((await g.check()).safe).toBe(true)
  })

  it('expired result + the poke returns a fresh probe → uses the fresh one', async () => {
    const g = createNetworkGate(deps({ findBx: () => null, current: () => probeState(true, 0), pokeNow: () => Promise.resolve(probeState(false, 1_000_000)), probeStaleMs: 60_000 }))
    expect(await g.check()).toEqual({ safe: false, source: 'probe', detail: '探测失败' })
  })
})
