import { describe, expect, it } from 'vitest'
import { runNetProbe, probeTargetsFor, verdictOf } from './net-probe'

describe('net-probe', () => {
  it('probeTargetsFor: baselines always present; provider endpoints follow registered ids', () => {
    const t = probeTargetsFor(['claude', 'codex'])
    const ids = t.map(x => x.id)
    expect(ids).toContain('baseline_cn')
    expect(ids).toContain('internet')
    expect(ids).toContain('anthropic')
    expect(ids).toContain('openai')
    expect(ids).not.toContain('google_ai')   // gemini/agy not registered
    // dedupe: codex+openai both map to openai endpoint, only once
    expect(ids.filter(x => x === 'openai')).toHaveLength(1)
  })

  it('runNetProbe: any HTTP response = reachable; network error/timeout = not', async () => {
    const results = await runNetProbe(
      [
        { id: 'a', label: 'A', url: 'https://a.example' },
        { id: 'b', label: 'B', url: 'https://b.example' },
        { id: 'c', label: 'C', url: 'https://c.example' },
      ],
      {
        fetcher: async (url) => {
          if (url.includes('a.example')) return { status: 204 }
          if (url.includes('b.example')) return { status: 403 }   // HTTP error still = reachable
          throw new Error('connect ETIMEDOUT')
        },
        now: (() => { let t = 0; return () => (t += 10) })(),
      },
    )
    expect(results.find(r => r.id === 'a')!.ok).toBe(true)
    expect(results.find(r => r.id === 'b')!.ok).toBe(true)
    expect(results.find(r => r.id === 'c')!.ok).toBe(false)
    expect(results.find(r => r.id === 'a')!.latency_ms).toBeGreaterThanOrEqual(0)
  })

  it('verdictOf: 国内通+国际不通 → no_international;全不通 → offline;国际通 → ok', () => {
    const mk = (cn: boolean, intl: boolean) => [
      { id: 'baseline_cn', label: '', ok: cn, latency_ms: 1 },
      { id: 'internet', label: '', ok: intl, latency_ms: 1 },
    ]
    expect(verdictOf(mk(true, false))).toBe('no_international')
    expect(verdictOf(mk(false, false))).toBe('offline')
    expect(verdictOf(mk(true, true))).toBe('ok')
    expect(verdictOf(mk(false, true))).toBe('ok')   // intl reachable is what matters
  })
})
