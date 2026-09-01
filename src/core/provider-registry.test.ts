import { describe, expect, it } from 'vitest'
import { createProviderRegistry, DEFAULT_CHEAP_EVAL_BUDGET_MS } from './provider-registry'
import { makeFakeSession } from './test-helpers'
import type { AgentProvider } from './agent-provider'

const stub: AgentProvider = {
  spawn: async () => makeFakeSession({
    events: [{ kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 }],
  }),
}

describe('ProviderRegistry', () => {
  it('starts empty', () => {
    const r = createProviderRegistry()
    expect(r.list()).toEqual([])
    expect(r.has('claude')).toBe(false)
    expect(r.get('claude')).toBeNull()
  })

  it('register + get + has + list', () => {
    const r = createProviderRegistry()
    r.register('claude', stub, { displayName: 'Claude', canResume: () => true })
    expect(r.has('claude')).toBe(true)
    expect(r.list()).toEqual(['claude'])
    const e = r.get('claude')
    expect(e?.provider).toBe(stub)
    expect(e?.opts.displayName).toBe('Claude')
    expect(e?.opts.canResume('/cwd', 'sid')).toBe(true)
  })

  it('throws on duplicate id', () => {
    const r = createProviderRegistry()
    r.register('claude', stub, { displayName: 'Claude', canResume: () => true })
    expect(() => r.register('claude', stub, { displayName: 'Claude2', canResume: () => true }))
      .toThrow(/already registered: claude/)
  })

  it('two providers coexist', () => {
    const r = createProviderRegistry()
    r.register('claude', stub, { displayName: 'Claude', canResume: () => true })
    r.register('codex', stub, { displayName: 'Codex', canResume: () => false })
    expect(r.list().sort()).toEqual(['claude', 'codex'])
    expect(r.get('codex')?.opts.displayName).toBe('Codex')
    expect(r.get('codex')?.opts.canResume('/x', 'y')).toBe(false)
  })

  it('open ProviderId — accepts arbitrary string ids (RFC 03 §3.3)', () => {
    const r = createProviderRegistry()
    r.register('gemini-experimental', stub, { displayName: 'Gemini', canResume: () => true })
    expect(r.has('gemini-experimental')).toBe(true)
  })

  describe('getCheapEval — provider-agnostic resolution (PR F)', () => {
    const stubWithCheap = (label: string): AgentProvider => ({
      spawn: async () => makeFakeSession({
        events: [{ kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 }],
      }),
      cheapEval: async () => label,
    })

    it('returns null when no registered provider implements cheapEval', () => {
      const r = createProviderRegistry()
      r.register('claude', stub, { displayName: 'Claude', canResume: () => true })
      expect(r.getCheapEval()).toBeNull()
    })

    it('returns cheapEval when registered provider implements it', async () => {
      const r = createProviderRegistry()
      r.register('codex', stubWithCheap('codex-text'), { displayName: 'Codex', canResume: () => true })
      const ce = r.getCheapEval()
      expect(ce).not.toBeNull()
      expect(await ce!('prompt')).toBe('codex-text')
    })

    it('prefers claude over codex when both registered', async () => {
      const r = createProviderRegistry()
      // Register codex FIRST to verify preference is not insertion-order.
      r.register('codex', stubWithCheap('codex-text'), { displayName: 'Codex', canResume: () => true })
      r.register('claude', stubWithCheap('claude-text'), { displayName: 'Claude', canResume: () => true })
      const ce = r.getCheapEval()
      expect(await ce!('prompt')).toBe('claude-text')
    })

    it('falls back to codex when claude registered without cheapEval', async () => {
      const r = createProviderRegistry()
      r.register('claude', stub, { displayName: 'Claude', canResume: () => true })
      r.register('codex', stubWithCheap('codex-text'), { displayName: 'Codex', canResume: () => true })
      const ce = r.getCheapEval()
      expect(await ce!('prompt')).toBe('codex-text')
    })

    it('falls back to any registered provider when neither claude nor codex registered', async () => {
      const r = createProviderRegistry()
      r.register('gemini', stubWithCheap('gemini-text'), { displayName: 'Gemini', canResume: () => true })
      const ce = r.getCheapEval()
      expect(await ce!('prompt')).toBe('gemini-text')
    })

    // spec §2: agy rides Google AI Pro subscription quota, no per-token
    // cost — preference slots it right after openai, ahead of claude.
    it('prefers agy over claude when both registered', async () => {
      const r = createProviderRegistry()
      r.register('claude', stubWithCheap('claude-text'), { displayName: 'Claude', canResume: () => true })
      r.register('agy', stubWithCheap('agy-text'), { displayName: 'Agy', canResume: () => true })
      const ce = r.getCheapEval()
      expect(await ce!('prompt')).toBe('agy-text')
    })

    it('prefers openai over agy when both registered', async () => {
      const r = createProviderRegistry()
      r.register('agy', stubWithCheap('agy-text'), { displayName: 'Agy', canResume: () => true })
      r.register('openai', stubWithCheap('openai-text'), { displayName: 'OpenAI', canResume: () => true })
      const ce = r.getCheapEval()
      expect(await ce!('prompt')).toBe('openai-text')
    })
  })

  describe('getStrongEval — the DEFAULT provider specifically (verdict)', () => {
    const stubWithStrong = (label: string): AgentProvider => ({
      spawn: async () => makeFakeSession({
        events: [{ kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 }],
      }),
      strongEval: async () => label,
    })

    it('returns the named provider strongEval — no cross-provider picking', async () => {
      const r = createProviderRegistry()
      r.register('claude', stubWithStrong('claude-strong'), { displayName: 'Claude', canResume: () => true })
      r.register('codex', stubWithStrong('codex-strong'), { displayName: 'Codex', canResume: () => true })
      expect(await r.getStrongEval('codex')!('p')).toBe('codex-strong')
      expect(await r.getStrongEval('claude')!('p')).toBe('claude-strong')
    })

    it('returns null when the provider is unregistered or lacks strongEval', () => {
      const r = createProviderRegistry()
      r.register('claude', stub, { displayName: 'Claude', canResume: () => true })
      expect(r.getStrongEval('claude')).toBeNull()  // registered, no strongEval
      expect(r.getStrongEval('codex')).toBeNull()   // unregistered
    })
  })
})

describe('getCheapEval — runtime failover (2026-08-24: agy auth-dead froze the whole ingest pipeline)', () => {
  function reg(impls: Record<string, (p: string) => Promise<string>>, now = () => 1000) {
    const r = createProviderRegistry({ now })
    for (const [id, cheapEval] of Object.entries(impls)) {
      r.register(id, { id, cheapEval } as never, {} as never)
    }
    return r
  }

  it('falls through to the next provider when the preferred one throws', async () => {
    const calls: string[] = []
    const r = reg({
      agy: async () => { calls.push('agy'); throw new Error('authentication failed') },
      claude: async () => { calls.push('claude'); return 'ok-from-claude' },
    })
    const ce = r.getCheapEval()!
    expect(await ce('prompt')).toBe('ok-from-claude')
    expect(calls).toEqual(['agy', 'claude'])
  })

  it('puts a failing provider on cooldown — later calls skip it without retrying', async () => {
    const calls: string[] = []
    let t = 1000
    const r = reg({
      agy: async () => { calls.push('agy'); throw new Error('auth') },
      claude: async () => { calls.push('claude'); return 'ok' },
    }, () => t)
    const ce = r.getCheapEval()!
    await ce('a')                      // agy fails → cooldown, claude answers
    await ce('b')                      // agy skipped entirely
    expect(calls).toEqual(['agy', 'claude', 'claude'])
    t += 11 * 60_000                   // past the 10-minute cooldown
    await ce('c')                      // agy retried
    expect(calls[calls.length - 2]).toBe('agy')
  })

  it("agy's ambiguous 'authentication failed or timed out' is treated as TRANSIENT, not auth (owner can log in — it's network/timeout)", async () => {
    const calls: string[] = []
    let t = 1000
    const r = reg({
      agy: async () => { calls.push('agy'); throw new Error('agy result status=ERROR: authentication failed or timed out') },
      claude: async () => { calls.push('claude'); return 'ok' },
    }, () => t)
    const ce = r.getCheapEval()!
    await ce('a')                      // agy fails → SHORT (10min) cooldown, not 60min
    t += 11 * 60_000                   // past the 10min transient cooldown
    await ce('b')                      // agy retried (would still be sidelined if mis-classed as auth)
    expect(calls.filter(c => c === 'agy')).toHaveLength(2)
  })

  it('an auth failure gets a longer cooldown than a transient one (does not self-heal in 10min)', async () => {
    const calls: string[] = []
    let t = 1000
    const r = reg({
      agy: async () => { calls.push('agy'); throw new Error('auth_failed: credentials stale') },
      claude: async () => { calls.push('claude'); return 'ok' },
    }, () => t)
    const ce = r.getCheapEval()!
    await ce('a')                      // agy auth-fails → 60min cooldown
    t += 11 * 60_000                   // past the 10min transient cooldown…
    await ce('b')                      // …but agy still skipped (auth cooldown is 60min)
    expect(calls.filter(c => c === 'agy')).toHaveLength(1)
    t += 50 * 60_000                   // past the 60min auth cooldown
    await ce('c')                      // now agy retried
    expect(calls.filter(c => c === 'agy')).toHaveLength(2)
  })

  it('throws the last error when every provider fails (watermark-preserving semantics intact)', async () => {
    const r = reg({
      agy: async () => { throw new Error('agy down') },
      claude: async () => { throw new Error('claude down') },
    })
    await expect(r.getCheapEval()!('p')).rejects.toThrow('claude down')
  })

  it('single provider: failures still throw (no cooldown lockout with nowhere to go)', async () => {
    let fail = true
    const r = reg({ claude: async () => { if (fail) throw new Error('blip'); return 'ok' } })
    const ce = r.getCheapEval()!
    await expect(ce('p')).rejects.toThrow('blip')
    fail = false
    expect(await ce('p')).toBe('ok')   // immediately usable again
  })
})

describe('getCheapEval — network preflight (2026-08-29: boot-time agy spawn with Google unreachable popped the OAuth browser)', () => {
  function reg(
    impls: Record<string, (p: string) => Promise<string>>,
    preflight: (id: string) => Promise<boolean>,
    now = () => 1000,
  ) {
    const r = createProviderRegistry({ now, cheapEvalPreflight: preflight })
    for (const [id, cheapEval] of Object.entries(impls)) {
      r.register(id, { id, cheapEval } as never, {} as never)
    }
    return r
  }

  it('an unreachable candidate is skipped WITHOUT being called — the call lands on the next one', async () => {
    const calls: string[] = []
    const r = reg({
      agy: async () => { calls.push('agy'); return 'from-agy' },
      claude: async () => { calls.push('claude'); return 'from-claude' },
    }, async (id) => id !== 'agy')
    expect(await r.getCheapEval()!('p')).toBe('from-claude')
    expect(calls).toEqual(['claude'])                       // agy never spawned
  })

  it('a preflight skip does NOT cool the provider down — it is re-checked on the very next call', async () => {
    const calls: string[] = []
    let reachable = false
    const r = reg({
      agy: async () => { calls.push('agy'); return 'from-agy' },
      claude: async () => { calls.push('claude'); return 'from-claude' },
    }, async (id) => id === 'agy' ? reachable : true)
    await r.getCheapEval()!('a')                            // agy skipped → claude
    reachable = true                                        // network came back
    expect(await r.getCheapEval()!('b')).toBe('from-agy')   // no cooldown in the way
    expect(calls).toEqual(['claude', 'agy'])
  })

  it('ALL candidates unreachable → throws instead of force-calling anyone', async () => {
    const calls: string[] = []
    const r = reg({
      agy: async () => { calls.push('agy'); return 'x' },
      claude: async () => { calls.push('claude'); return 'y' },
    }, async () => false)
    await expect(r.getCheapEval()!('p')).rejects.toThrow(/reachable/)
    expect(calls).toEqual([])                               // nobody spawned
  })

  it('a preflight that THROWS fails open — the candidate still runs', async () => {
    const r = reg({
      agy: async () => 'from-agy',
    }, async () => { throw new Error('probe machinery broke') })
    expect(await r.getCheapEval()!('p')).toBe('from-agy')
  })

  it('everyone cooling down but reachable → the stale-blacklist escape still force-tries the first candidate', async () => {
    const calls: string[] = []
    let t = 1000
    const r = reg({
      agy: async () => { calls.push('agy'); throw new Error('down') },
      claude: async () => { calls.push('claude'); throw new Error('down') },
    }, async () => true, () => t)
    await r.getCheapEval()!('a').catch(() => {})            // both fail → both cooling
    calls.length = 0
    const r2 = await r.getCheapEval()!('b').catch(() => 'threw')
    expect(r2).toBe('threw')
    expect(calls).toEqual(['agy'])                          // escape hatch force-tried first
  })
})

// 2026-09-01:披露闸门写死 12s 超时,而 agy(订阅版 Gemini,CLI 冷启动)
// 单次实测 10.3–14.3s —— 派心愿时灵时不灵。一个常数服务不了 in-process
// (约 1s)和 CLI(10-20s)两档,所以延迟预算得由 provider 自己声明,
// 由 registry 汇总给延迟敏感的调用方。
describe('getCheapEvalBudgetMs —— 延迟预算由 provider 声明', () => {
  const bare = (cheap = true, budget?: number) => ({
    name: 'p', spawn: async () => ({}) as never,
    ...(cheap ? { cheapEval: async () => 'x' } : {}),
    ...(budget !== undefined ? { cheapEvalBudgetMs: budget } : {}),
  }) as never

  it('没人声明 → 默认(in-process 一档)', () => {
    const r = createProviderRegistry()
    r.register('claude', bare(), { displayName: 'P', canResume: () => false })
    expect(r.getCheapEvalBudgetMs()).toBe(DEFAULT_CHEAP_EVAL_BUDGET_MS)
  })

  it('取候选里最大的 —— 故障转移可能落到任何一个,不能按最快的那个定超时', () => {
    const r = createProviderRegistry()
    r.register('claude', bare(), { displayName: 'P', canResume: () => false })
    r.register('agy', bare(true, 30_000), { displayName: 'P', canResume: () => false })
    expect(r.getCheapEvalBudgetMs()).toBe(30_000)
  })

  it('钉死了 provider 就只看它的 —— 钉 claude 不该被 agy 的预算拖长', () => {
    const r = createProviderRegistry({ cheapEvalProvider: 'claude' })
    r.register('claude', bare(), { displayName: 'P', canResume: () => false })
    r.register('agy', bare(true, 30_000), { displayName: 'P', canResume: () => false })
    expect(r.getCheapEvalBudgetMs()).toBe(DEFAULT_CHEAP_EVAL_BUDGET_MS)
  })

  it('钉的那个没注册 → 回落偏好序的最大值(与 getCheapEval 的回落一致)', () => {
    const r = createProviderRegistry({ cheapEvalProvider: 'nope' })
    r.register('agy', bare(true, 30_000), { displayName: 'P', canResume: () => false })
    expect(r.getCheapEvalBudgetMs()).toBe(30_000)
  })

  it('一个 cheapEval 都没有 → 默认值,不抛', () => {
    const r = createProviderRegistry()
    r.register('claude', bare(false), { displayName: 'P', canResume: () => false })
    expect(r.getCheapEvalBudgetMs()).toBe(DEFAULT_CHEAP_EVAL_BUDGET_MS)
  })
})
