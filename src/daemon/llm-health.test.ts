import { describe, expect, it, vi } from 'vitest'
import { makeLlmHealth } from './llm-health'
import { errorWithProviderCode } from '../lib/provider-error-code'

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

  // arch backlog #4 第 2 步 + 红线 B:「测试连接」以前直接跑宽档散文正则,agy 那句
  // `authentication failed or timed out` 被报成 AUTH FAILED + 去重新登录。现在码优先,
  // 无码回退到网络优先的文本判定。
  it('reads the provider code first; the agy ambiguous line is never AUTH FAILED; auth_rejected gets no re-login hint', async () => {
    const h = makeLlmHealth({
      registry: reg({
        agy: { cheapEval: async () => { throw new Error('agy result status=ERROR: authentication failed or timed out') } },
        agyCoded: { cheapEval: async () => { throw errorWithProviderCode('agy result status=ERROR: authentication failed or timed out', 'network') } },
        openai: { cheapEval: async () => { throw errorWithProviderCode('Invalid Authentication', 'auth_rejected') } },
        claude: { cheapEval: async () => { throw errorWithProviderCode('Not logged in · Please run /login', 'auth_failed') } },
        codex: { cheapEval: async () => { throw errorWithProviderCode('unexpected status 401 Unauthorized ... (rate limit)', 'rate_limited') } },
      }) as never,
      defaultProviderId: 'claude' as never,
      hintFor: () => '请重新登录一次',
      timeoutMs: 5_000,
      log: () => {},
    })
    const by = Object.fromEntries((await h.dial()).results.map((x: { provider: string }) => [x.provider, x]))
    expect(by['agy']).toMatchObject({ ok: false, auth_failed: false })
    expect(by['agy']).not.toHaveProperty('hint')
    expect(by['agyCoded']).toMatchObject({ ok: false, auth_failed: false, code: 'network' })
    expect(by['openai']).toMatchObject({ ok: false, auth_failed: true, code: 'auth_rejected' })
    expect((by['openai'] as { hint: string }).hint).not.toMatch(/登录/)
    expect(by['claude']).toMatchObject({ ok: false, auth_failed: true, code: 'auth_failed', hint: '请重新登录一次' })
    // 码说「限流」⇒ 不是认证,哪怕正文里有 401。
    expect(by['codex']).toMatchObject({ ok: false, auth_failed: false, code: 'rate_limited' })
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

it('current-only testing never calls other configured services', async () => {
 const current=vi.fn(async()=> 'ok'), other=vi.fn(async()=> 'ok')
 const h=makeLlmHealth({registry:reg({claude:{cheapEval:current},cursor:{cheapEval:other}}) as never,defaultProviderId:'claude',log:()=>{}})
 const r=await h.dial('current')
 expect(r.results.map(x=>x.provider)).toEqual(['claude'])
 expect(current).toHaveBeenCalledTimes(1)
 expect(other).not.toHaveBeenCalled()
})
