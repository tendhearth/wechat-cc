import { describe, it, expect, vi } from 'vitest'
import { createProviderRegistry, withNetworkGate } from './provider-registry'
import type { AgentProvider } from './agent-provider'
import { makeFakeSession } from './test-helpers'

function gate(state: { safe: boolean }) {
  return { check: async () => ({ safe: state.safe, source: 'bx' as const, detail: state.safe ? 'bx 保护中' : 'bx 未保护' }) }
}

function fakeProvider() {
  const spawn = vi.fn(async () => makeFakeSession({ events: [] }))
  const cheapEval = vi.fn(async (_p: string) => 'cheap')
  const strongEval = vi.fn(async (_p: string) => 'strong')
  const modelCatalog = vi.fn(async () => ({ models: [] }) as never)
  const p = { spawn, cheapEval, strongEval, modelCatalog } as unknown as AgentProvider
  return { p, spawn, cheapEval, strongEval, modelCatalog }
}

describe('withNetworkGate', () => {
  it('unsafe → spawn / cheapEval / strongEval / modelCatalog all refuse without calling the provider', async () => {
    const f = fakeProvider()
    const g = withNetworkGate(f.p, gate({ safe: false }))
    await expect(g.spawn({ alias: 'a', path: '/a' }, {} as never)).rejects.toMatchObject({ code: 'network_unprotected' })
    await expect(g.cheapEval!('x')).rejects.toMatchObject({ code: 'network_unprotected' })
    await expect(g.strongEval!('x')).rejects.toMatchObject({ code: 'network_unprotected' })
    await expect(g.modelCatalog!({ alias: 'a', path: '/a' })).rejects.toMatchObject({ code: 'network_unprotected' })
    expect(f.spawn).not.toHaveBeenCalled()
    expect(f.cheapEval).not.toHaveBeenCalled()
    expect(f.strongEval).not.toHaveBeenCalled()
    expect(f.modelCatalog).not.toHaveBeenCalled()
  })

  it('safe → passes through; keeps extra props and absent optional methods absent', async () => {
    const f = fakeProvider()
    const withExtra = Object.assign(f.p, { probeStatus: () => ({ state: 'ok' }) })
    const g = withNetworkGate(withExtra, gate({ safe: true }))
    expect(await g.cheapEval!('x')).toBe('cheap')
    expect((g as typeof withExtra).probeStatus()).toEqual({ state: 'ok' })
    const bare = withNetworkGate({ spawn: f.spawn } as unknown as AgentProvider, gate({ safe: true }))
    expect(bare.cheapEval).toBeUndefined()
  })
})

describe('createProviderRegistry({ networkGate })', () => {
  it('every registered provider is gated (direct entry.provider access included)', async () => {
    const state = { safe: false }
    const r = createProviderRegistry({ networkGate: gate(state) })
    const f = fakeProvider()
    r.register('claude', f.p, { displayName: 'Claude', canResume: () => true })
    await expect(r.get('claude')!.provider.cheapEval!('x')).rejects.toMatchObject({ code: 'network_unprotected' })
    await expect(r.getStrongEval('claude')!('x')).rejects.toMatchObject({ code: 'network_unprotected' })
    expect(f.cheapEval).not.toHaveBeenCalled()
    state.safe = true
    expect(await r.get('claude')!.provider.cheapEval!('x')).toBe('cheap')
  })

  it('cheapEval failover: unsafe → throws before any candidate, and nobody is put on cooldown', async () => {
    const state = { safe: false }
    const r = createProviderRegistry({ networkGate: gate(state) })
    const a = fakeProvider(), b = fakeProvider()
    r.register('openai', a.p, { displayName: 'OpenAI', canResume: () => false })
    r.register('claude', b.p, { displayName: 'Claude', canResume: () => true })
    const ce = r.getCheapEval()!
    await expect(ce('x')).rejects.toMatchObject({ code: 'network_unprotected' })
    expect(a.cheapEval).not.toHaveBeenCalled()
    expect(b.cheapEval).not.toHaveBeenCalled()
    // 网络一恢复,第一候选立刻可用(没被冷却)
    state.safe = true
    expect(await ce('x')).toBe('cheap')
    expect(a.cheapEval).toHaveBeenCalledTimes(1)
  })
})
