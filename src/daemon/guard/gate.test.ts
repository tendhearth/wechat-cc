import { describe, it, expect, vi } from 'vitest'
import { createNetworkGate, type NetworkGateDeps } from './gate'
import { initialState, type GuardState } from './scheduler'
import { assertNetworkSafe, isNetworkUnprotectedError, unprotectedMessage } from '../../lib/network-gate'

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

  it('bx not installed → legacy probe semantics (reachable)', async () => {
    const readBx = vi.fn(async () => DOWN_BX)
    const g = createNetworkGate(deps({ findBx: () => null, readBx, current: () => ({ ...initialState(), reachable: false, safe: false, detail: '探测失败' }) }))
    expect(await g.check()).toEqual({ safe: false, source: 'probe', detail: '探测失败' })
    const g2 = createNetworkGate(deps({ findBx: () => null, readBx }))
    expect((await g2.check()).safe).toBe(true)  // 没装 bx、调度器未起:与旧行为一致(初始放行)
    expect(readBx).not.toHaveBeenCalled()
  })
})

describe('assertNetworkSafe', () => {
  it('throws NetworkUnprotectedError carrying the uniform message', async () => {
    const g = createNetworkGate(deps({ readBx: async () => DOWN_BX }))
    const err = await assertNetworkSafe(g).catch(e => e)
    expect(isNetworkUnprotectedError(err)).toBe(true)
    expect(err.message).toBe(unprotectedMessage({ source: 'bx' }))
    expect(err.message).toBe('网络未受保护(bx 未连上),CC 先暂停，恢复后再试。')
  })

  it('a throwing gate is treated as unsafe', async () => {
    const err = await assertNetworkSafe({ check: async () => { throw new Error('x') } }).catch(e => e)
    expect(isNetworkUnprotectedError(err)).toBe(true)
  })

  it('no gate / safe gate → resolves', async () => {
    await expect(assertNetworkSafe(undefined)).resolves.toBeUndefined()
    await expect(assertNetworkSafe(createNetworkGate(deps()))).resolves.toBeUndefined()
  })
})
