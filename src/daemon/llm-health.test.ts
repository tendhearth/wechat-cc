import { describe, expect, it, vi } from 'vitest'
import { makeLlmHealth } from './llm-health'

function reg(providers: Record<string, { cheapEval?: (p: string) => Promise<string> }>) {
  return {
    list: () => Object.keys(providers) as never[],
    get: (id: string) => (providers[id] ? { provider: providers[id], opts: { displayName: id } } : null),
  }
}

describe('makeLlmHealth', () => {
  it('probes every provider concurrently and classifies ok / auth / error', async () => {
    const h = makeLlmHealth({
      registry: reg({
        claude: { cheapEval: async () => 'ok' },
        cursor: { cheapEval: async () => { throw new Error('auth_failed: Not logged in') } },
        codex: { cheapEval: async () => { throw new Error('spawn ENOENT') } },
      }) as never,
      defaultProviderId: 'claude' as never,
      hintFor: (id) => (id === 'cursor' ? '跑一次 cursor-agent login' : undefined),
      timeoutMs: 5_000,
      log: () => {},
    })
    const r = await h.probe(true)
    const by = Object.fromEntries(r.results.map(x => [x.provider, x]))
    expect(by['claude']).toMatchObject({ ok: true })
    expect(by['claude']!.latency_ms).toBeGreaterThanOrEqual(0)
    expect(by['cursor']).toMatchObject({ ok: false, auth_failed: true, hint: '跑一次 cursor-agent login' })
    expect(by['codex']).toMatchObject({ ok: false, auth_failed: false })
    expect(r.default_provider).toBe('claude')
    expect(typeof r.checked_at).toBe('string')
  })

  it('a hung provider is classified timeout, not a hang for the caller', async () => {
    const h = makeLlmHealth({
      registry: reg({ claude: { cheapEval: () => new Promise(() => {}) } }) as never,
      defaultProviderId: 'claude' as never,
      timeoutMs: 50,
      log: () => {},
    })
    const r = await h.probe(true)
    expect(r.results[0]).toMatchObject({ ok: false, error: 'timeout' })
  })

  it('provider without a probe surface is reported untested, never crashes', async () => {
    const h = makeLlmHealth({
      registry: reg({ openai: {} }) as never,
      defaultProviderId: 'openai' as never,
      timeoutMs: 1_000,
      log: () => {},
    })
    const r = await h.probe(true)
    expect(r.results[0]).toMatchObject({ provider: 'openai', ok: null })
  })

  it('caches results for ttl; fresh=true bypasses', async () => {
    const cheapEval = vi.fn(async () => 'ok')
    let t = 1_000_000
    const h = makeLlmHealth({
      registry: reg({ claude: { cheapEval } }) as never,
      defaultProviderId: 'claude' as never,
      timeoutMs: 1_000,
      ttlMs: 60_000,
      now: () => t,
      log: () => {},
    })
    await h.probe(false)
    await h.probe(false)
    expect(cheapEval).toHaveBeenCalledTimes(1)     // cached
    await h.probe(true)
    expect(cheapEval).toHaveBeenCalledTimes(2)     // fresh bypass
    t += 61_000
    await h.probe(false)
    expect(cheapEval).toHaveBeenCalledTimes(3)     // ttl lapsed
  })
})
