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
    const r = await h.dial()
    const by = Object.fromEntries(r.results.map((x: { provider: string; latency_ms: number }) => [x.provider, x]))
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
    const r = await h.dial()
    expect(r.results[0]).toMatchObject({ ok: false, error: 'timeout' })
  })

  it('provider without a probe surface is reported untested, never crashes', async () => {
    const h = makeLlmHealth({
      registry: reg({ openai: {} }) as never,
      defaultProviderId: 'openai' as never,
      timeoutMs: 1_000,
      log: () => {},
    })
    const r = await h.dial()
    expect(r.results[0]).toMatchObject({ provider: 'openai', ok: null })
  })

  it('cached() NEVER dials — only dial() does, and concurrent dials coalesce', async () => {
    const cheapEval = vi.fn(async () => 'ok')
    const h = makeLlmHealth({
      registry: reg({ claude: { cheapEval } }) as never,
      defaultProviderId: 'claude' as never,
      timeoutMs: 1_000,
      log: () => {},
    })
    expect(h.cached()).toBeNull()
    expect(cheapEval).not.toHaveBeenCalled()       // no auto-dial, ever
    const [a, b] = await Promise.all([h.dial(), h.dial()])
    expect(cheapEval).toHaveBeenCalledTimes(1)     // coalesced
    expect(a).toBe(b)
    expect(h.cached()).toBe(a)                     // cached() returns it without dialing
    expect(cheapEval).toHaveBeenCalledTimes(1)
  })

  it('unconfigured hints cover known providers minus registered', async () => {
    const { unconfiguredHints, PROVIDER_SETUP_HINTS } = await import('./llm-health')
    const hints = unconfiguredHints(['claude', 'codex'])
    expect(hints.map(h2 => h2.provider)).not.toContain('claude')
    expect(hints.map(h2 => h2.provider)).toContain('cursor')
    expect(hints.find(h2 => h2.provider === 'cursor')!.how).toContain('cursor-agent login')
    expect(Object.keys(PROVIDER_SETUP_HINTS).length).toBeGreaterThanOrEqual(6)
  })
})
