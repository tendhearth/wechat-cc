import { describe, it, expect, vi } from 'vitest'
import { makeMemoryLlmOps } from './memory-llm-ops'

// NOTE: brief used '../../lib/memory-synthesis' — that resolves one level
// too high from src/daemon/. Both this test file and memory-llm-ops.ts live
// in src/daemon/, so the correct relative path (matching the impl's own
// dynamic import) is '../lib/memory-synthesis'.
vi.mock('../lib/memory-synthesis', () => ({
  synthesizeOverview: vi.fn(async (o: any) => ({ ok: true, written: { path: '_overview.md', bytesWritten: 10 }, _eval: await o.sdkEval('x') })),
  synthesizeProfile: vi.fn(async (o: any) => ({ ok: true, written: { path: '_profile.json', bytesWritten: 5 }, _eval: await o.sdkEval('y') })),
  OVERVIEW_FILENAME: '_overview.md',
}))
vi.mock('./life-stores', () => ({ makeLifeStoresReader: () => ({}) }))

function make(over: Record<string, any> = {}) {
  const cheapEval = vi.fn(async (p: string) => `EVAL:${p}`)
  const deps = {
    stateDir: '/tmp/s', db: {} as any,
    getMode: vi.fn(() => ({ kind: 'solo', provider: 'claude' })),
    registry: { get: vi.fn(() => ({ provider: { cheapEval } })), getCheapEval: () => cheapEval },
    ...over,
  }
  return { ops: makeMemoryLlmOps(deps as any), cheapEval, deps }
}

describe('makeMemoryLlmOps', () => {
  it('synthesize 用会话 provider 的 cheapEval', async () => {
    const { ops, cheapEval } = make()
    const r = await ops.synthesize('admin1') as any
    expect(r.written.path).toBe('_overview.md')
    expect(cheapEval).toHaveBeenCalled()          // sdkEval routed to the daemon cheapEval
  })
  it('generateProfile 用同一 cheapEval', async () => {
    const { ops, cheapEval } = make()
    const r = await ops.generateProfile('admin1') as any
    expect(r.written.path).toBe('_profile.json')
    expect(cheapEval).toHaveBeenCalled()
  })
  it('会话非 solo → 回落 registry.getCheapEval', async () => {
    const cheap = vi.fn(async () => 'X')
    const { ops } = make({ getMode: () => ({ kind: 'parallel' }), registry: { get: () => undefined, getCheapEval: () => cheap } })
    await ops.synthesize('a')
    expect(cheap).toHaveBeenCalled()
  })
  it('无任何 provider → 抛 no LLM provider', async () => {
    const { ops } = make({ getMode: () => undefined, registry: { get: () => undefined, getCheapEval: () => null } })
    await expect(ops.synthesize('a')).rejects.toThrow(/no LLM provider/)
  })
})
