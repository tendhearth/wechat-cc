import { describe, expect, it } from 'vitest'
import { runNetProbe, probeTargetsFor, verdictOf, dialAdvisable, endpointFor } from './net-probe'

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

  it('endpointFor: 自配 base_url 探真实 origin,而非硬编码 api.openai.com', () => {
    const custom = endpointFor('openai', { openai: 'https://llm.mycorp.cn/v1/chat' })
    expect(custom).toEqual({ id: 'custom_openai', label: expect.stringContaining('自配'), url: 'https://llm.mycorp.cn' })
    // 无 override → 回落静态映射
    expect(endpointFor('openai')!.url).toBe('https://api.openai.com')
    // 非法 base_url → 回落静态映射,不炸
    expect(endpointFor('openai', { openai: 'not a url' })!.url).toBe('https://api.openai.com')
  })

  it('probeTargetsFor: 自配 openai 端点进探测列表,不再探 api.openai.com', () => {
    const t = probeTargetsFor(['openai'], { openai: 'https://llm.mycorp.cn/v1' })
    const ids = t.map(x => x.id)
    expect(ids).toContain('custom_openai')
    expect(ids).not.toContain('openai')   // 硬编码国际端点不再被探
    expect(t.find(x => x.id === 'custom_openai')!.url).toBe('https://llm.mycorp.cn')
  })

  it('dialAdvisable: 国内自配大脑端点可达 → 该拨,哪怕国际不通', () => {
    const results = [
      { id: 'baseline_cn', label: '', ok: true, latency_ms: 1 },
      { id: 'internet', label: '', ok: false, latency_ms: 1 },     // 国际出口不通
      { id: 'custom_openai', label: '', ok: true, latency_ms: 1 }, // 但自配大脑通
    ]
    expect(verdictOf(results)).toBe('no_international')             // 老判定仍说「没国际」
    expect(dialAdvisable(results, ['openai'], { openai: 'https://llm.mycorp.cn' })).toBe(true)  // 但值得拨
  })

  it('dialAdvisable: 全是国际大脑且端点都不通 → 别拨(先开代理)', () => {
    const results = [
      { id: 'baseline_cn', label: '', ok: true, latency_ms: 1 },
      { id: 'internet', label: '', ok: false, latency_ms: 1 },
      { id: 'anthropic', label: '', ok: false, latency_ms: 1 },
      { id: 'openai', label: '', ok: false, latency_ms: 1 },
    ]
    expect(dialAdvisable(results, ['claude', 'codex'])).toBe(false)
  })

  it('dialAdvisable: 没有可解析端点 → 不预拦,让真拨说话', () => {
    expect(dialAdvisable([], ['some_unknown_provider'])).toBe(true)
  })
})
