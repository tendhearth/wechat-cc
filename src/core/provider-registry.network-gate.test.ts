import { describe, it, expect, vi } from 'vitest'
import { createProviderRegistry, providerCallTarget, withNetworkGate } from './provider-registry'
import type { AgentProvider } from './agent-provider'
import { makeFakeSession } from './test-helpers'
import type { NetworkGate } from '../lib/network-gate'
import { classifyCall } from '../lib/call-classifier'

// 守护 v2(2026-10-02):按调用判 —— 需要保护的调用才看信号;不需要保护的(国内 / 自建 / Cursor auto)照常。
function gate(state: { safe: boolean }, resolve: (t: Parameters<typeof classifyCall>[0]) => Parameters<typeof classifyCall>[0] = t => t): NetworkGate & { check: ReturnType<typeof vi.fn> } {
  const check = vi.fn(async () => ({ safe: state.safe, source: 'bx' as const, detail: state.safe ? 'bx 保护中' : 'bx 未保护' }))
  return { check, classify: (t) => classifyCall(resolve(t)) }
}
// 测试里 openai 指向 DeepSeek(国内,不需要保护)。
const deepseekOpenai = (t: Parameters<typeof classifyCall>[0]) => (t.provider === 'openai' ? { ...t, baseUrl: 'https://api.deepseek.com/v1' } : t)

/** id 给了 ⇒ provider 报自己的目标(和真的 provider 一样:id + 这次钉的模型);不给 ⇒ 不报(拿不准)。 */
function fakeProvider(tag = 'cheap', id?: string) {
  const spawn = vi.fn(async () => makeFakeSession({ events: [] }))
  const cheapEval = vi.fn(async (_p: string) => tag)
  const strongEval = vi.fn(async (_p: string) => 'strong')
  const modelCatalog = vi.fn(async () => ({ models: [] }) as never)
  const callTarget = id ? (_kind: string, ctx?: { model?: string; execution?: { model: string | null } }) => ({ provider: id, model: ctx?.model ?? ctx?.execution?.model ?? null }) : undefined
  const p = { spawn, cheapEval, strongEval, modelCatalog, ...(callTarget ? { callTarget } : {}) } as unknown as AgentProvider
  return { p, spawn, cheapEval, strongEval, modelCatalog }
}

describe('providerCallTarget (review #193)', () => {
  it('asks the provider; spawn falls back to its session target; marks the result exact', () => {
    const f = fakeProvider('x', 'cursor')
    expect(providerCallTarget(f.p, 'cursor', 'spawn', { model: 'gpt-5' })).toEqual({ provider: 'cursor', model: 'gpt-5', purpose: 'turn', exact: true })
    expect(providerCallTarget(f.p, 'cursor', 'session', { execution: { defaults: 'provider', model: 'claude-4.5-sonnet', reasoningEffort: null } })).toMatchObject({ model: 'claude-4.5-sonnet', exact: true })
    expect(providerCallTarget(f.p, 'cursor', 'cheapEval')).toMatchObject({ purpose: 'eval', exact: true })
  })
  it('a provider that reports nothing (or throws) → unresolved (fail closed)', () => {
    expect(providerCallTarget(fakeProvider().p, 'openai', 'cheapEval')).toEqual({ provider: 'openai', purpose: 'eval', unresolved: true })
    expect(providerCallTarget({ spawn: vi.fn(), callTarget: () => { throw new Error('x') } } as unknown as AgentProvider, 'cursor', 'spawn')).toMatchObject({ unresolved: true })
    expect(classifyCall(providerCallTarget(null, 'cursor', 'session')).protected).toBe(true)
  })
})

describe('withNetworkGate', () => {
  it('protected provider + unsafe → spawn / cheapEval / strongEval / modelCatalog all refuse without calling it', async () => {
    const f = fakeProvider()
    const g = withNetworkGate(f.p, gate({ safe: false }), 'claude')
    await expect(g.spawn({ alias: 'a', path: '/a' }, {} as never)).rejects.toMatchObject({ code: 'network_unprotected', message: '网络未受保护(bx 未连上),用到 Claude 的这一步先暂停，恢复后再试。' })
    await expect(g.cheapEval!('x')).rejects.toMatchObject({ code: 'network_unprotected' })
    await expect(g.strongEval!('x')).rejects.toMatchObject({ code: 'network_unprotected' })
    await expect(g.modelCatalog!({ alias: 'a', path: '/a' })).rejects.toMatchObject({ code: 'network_unprotected' })
    expect(f.spawn).not.toHaveBeenCalled()
    expect(f.cheapEval).not.toHaveBeenCalled()
  })

  it('unprotected call + unsafe → goes through and never even reads the signal', async () => {
    const f = fakeProvider('cheap', 'cursor')
    const st = { safe: false }
    const gt = gate(st)
    const cursor = withNetworkGate(f.p, gt, 'cursor')
    await cursor.spawn({ alias: 'a', path: '/a' }, { model: 'auto' } as never)
    await cursor.spawn({ alias: 'a', path: '/a' }, { model: 'default[]' } as never)  // cursor-agent 的 Auto
    await cursor.modelCatalog!({ alias: 'a', path: '/a' })
    expect(f.spawn).toHaveBeenCalledTimes(2)
    expect(gt.check).not.toHaveBeenCalled()
    // 同一个 Cursor,选了 auto 以外的模型(Claude,或 Cursor 自家的 composer)→ 需要保护 → 拒
    await expect(cursor.spawn({ alias: 'a', path: '/a' }, { model: 'claude-4.5-sonnet' } as never)).rejects.toMatchObject({ code: 'network_unprotected' })
    await expect(cursor.spawn({ alias: 'a', path: '/a' }, { model: 'composer-2' } as never)).rejects.toMatchObject({ code: 'network_unprotected' })
    expect(f.spawn).toHaveBeenCalledTimes(2)
  })

  it('safe → passes through; keeps extra props and absent optional methods absent', async () => {
    const f = fakeProvider()
    const withExtra = Object.assign(f.p, { probeStatus: () => ({ state: 'ok' }) })
    const g = withNetworkGate(withExtra, gate({ safe: true }), 'claude')
    expect(await g.cheapEval!('x')).toBe('cheap')
    expect((g as typeof withExtra).probeStatus()).toEqual({ state: 'ok' })
    const bare = withNetworkGate({ spawn: f.spawn } as unknown as AgentProvider, gate({ safe: true }), 'claude')
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

  it('cheapEval failover: unsafe → skips protected candidates (no cooldown), still uses the unprotected one', async () => {
    const state = { safe: false }
    const r = createProviderRegistry({ networkGate: gate(state) })
    const agy = fakeProvider('agy', 'agy'), cursor = fakeProvider('cursor-auto', 'cursor'), claude = fakeProvider('claude', 'claude')
    // 偏好序 agy → claude,cursor 不在偏好序里排最后:前两个需要保护被跳过,落到 Cursor auto。
    r.register('agy', agy.p, { displayName: 'agy', canResume: () => false })
    r.register('claude', claude.p, { displayName: 'Claude', canResume: () => true })
    r.register('cursor', cursor.p, { displayName: 'Cursor', canResume: () => false })
    const ce = r.getCheapEval()!
    expect(await ce('x')).toBe('cursor-auto')
    expect(agy.cheapEval).not.toHaveBeenCalled()
    expect(claude.cheapEval).not.toHaveBeenCalled()
  })

  it('cheapEval failover: protected candidates skipped while unsafe are NOT cooled down — first in order is used again once safe', async () => {
    const state = { safe: false }
    const log = vi.fn()
    const r = createProviderRegistry({ networkGate: gate(state, deepseekOpenai), log })
    const agy = fakeProvider('agy'), claude = fakeProvider('claude'), ds = fakeProvider('deepseek')
    r.register('agy', agy.p, { displayName: 'agy', canResume: () => false })
    r.register('claude', claude.p, { displayName: 'Claude', canResume: () => true })
    r.register('deepseek', ds.p, { displayName: 'DS', canResume: () => false })  // 不在偏好序里 → 排最后;不认识的 id 默认保护
    const ce = r.getCheapEval()!
    await expect(ce('x')).rejects.toMatchObject({ code: 'network_unprotected' })
    expect(agy.cheapEval).not.toHaveBeenCalled()
    expect(claude.cheapEval).not.toHaveBeenCalled()
    expect(ds.cheapEval).not.toHaveBeenCalled()
    expect(log.mock.calls.some(c => String(c[0]).includes('跳过(不入冷却)'))).toBe(true)
    state.safe = true
    expect(await ce('x')).toBe('agy')
  })

  it('cheapEval failover: only refuses when nothing eligible remains (all protected + unsafe)', async () => {
    const state = { safe: false }
    const r = createProviderRegistry({ networkGate: gate(state) })
    const a = fakeProvider(), b = fakeProvider()
    r.register('openai', a.p, { displayName: 'OpenAI', canResume: () => false })  // 没有 base URL ⇒ api.openai.com ⇒ 需要保护
    r.register('claude', b.p, { displayName: 'Claude', canResume: () => true })
    const err = await r.getCheapEval()!('x').catch(e => e)
    expect(err).toMatchObject({ code: 'network_unprotected' })
    expect(a.cheapEval).not.toHaveBeenCalled()
    expect(b.cheapEval).not.toHaveBeenCalled()
  })

  it('mixed: Claude chat paused while a DeepSeek background judgement in the same registry proceeds', async () => {
    const state = { safe: false }
    const r = createProviderRegistry({ networkGate: gate(state, deepseekOpenai), cheapEvalProvider: 'openai' })
    const claude = fakeProvider('claude', 'claude'), ds = fakeProvider('deepseek', 'openai')
    r.register('claude', claude.p, { displayName: 'Claude', canResume: () => true })
    r.register('openai', ds.p, { displayName: 'DeepSeek', canResume: () => false })
    const [chat, judge] = await Promise.allSettled([
      r.get('claude')!.provider.spawn({ alias: 'a', path: '/a' }, {} as never),
      r.getCheapEval()!('judge this'),
    ])
    expect(chat).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ code: 'network_unprotected' }) })
    expect(judge).toEqual({ status: 'fulfilled', value: 'deepseek' })
    expect(claude.spawn).not.toHaveBeenCalled()
  })

  it('a domestic candidate that fails with an ordinary connection error is NOT labelled 网络未受保护', async () => {
    const state = { safe: false }
    const r = createProviderRegistry({ networkGate: gate(state, deepseekOpenai) })
    const ds = fakeProvider('cheap', 'openai'), claude = fakeProvider('cheap', 'claude')
    ds.cheapEval.mockRejectedValue(new Error('fetch failed: ECONNREFUSED'))
    r.register('openai', ds.p, { displayName: 'DeepSeek', canResume: () => false })
    r.register('claude', claude.p, { displayName: 'Claude', canResume: () => true })
    const err = await r.getCheapEval()!('x').catch(e => e)
    expect(err.message).toBe('fetch failed: ECONNREFUSED')
    expect(err.code).toBeUndefined()
  })
})
