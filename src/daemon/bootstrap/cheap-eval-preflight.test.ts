import { describe, it, expect, vi } from 'vitest'
import { makeCheapEvalPreflight } from './cheap-eval-preflight'

function okFetcher() {
  return vi.fn(async (_url: string, _signal: AbortSignal) => ({ status: 404 })) // any HTTP response = reachable
}
function deadFetcher() {
  return vi.fn(async (_url: string, _signal: AbortSignal): Promise<{ status: number }> => {
    throw new Error('connect timeout')
  })
}

describe('makeCheapEvalPreflight', () => {
  it('reachable endpoint → true; the verdict is cached inside okTtl (no second fetch)', async () => {
    const fetcher = okFetcher()
    let t = 1000
    const pf = makeCheapEvalPreflight({ fetcher, now: () => t, okTtlMs: 60_000 })
    expect(await pf('agy')).toBe(true)
    t += 30_000
    expect(await pf('agy')).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(1)
    t += 60_000                                             // past okTtl → re-probe
    await pf('agy')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('unreachable endpoint → false; failure is cached only failTtl, then re-probed', async () => {
    const fetcher = deadFetcher()
    let t = 1000
    const pf = makeCheapEvalPreflight({ fetcher, now: () => t, failTtlMs: 15_000 })
    expect(await pf('agy')).toBe(false)
    t += 5_000
    expect(await pf('agy')).toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(1)                // cached failure
    t += 15_000
    await pf('agy')
    expect(fetcher).toHaveBeenCalledTimes(2)                // network may be back — re-probe
  })

  it('provider without a known endpoint → true without any fetch (fail-open)', async () => {
    const fetcher = okFetcher()
    const pf = makeCheapEvalPreflight({ fetcher })
    expect(await pf('some-plugin-provider')).toBe(true)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('custom openai base_url override → probes the override origin, not api.openai.com', async () => {
    const fetcher = okFetcher()
    const pf = makeCheapEvalPreflight({ fetcher, overrides: () => ({ openai: 'http://127.0.0.1:8000/v1' }) })
    await pf('openai')
    expect(fetcher.mock.calls[0]![0]).toBe('http://127.0.0.1:8000')
  })

  // 2026-10-23 抓包:agy 连的是 daily-cloudcode-pa.googleapis.com,不是带密钥那家的 generativelanguage —— 以前共用一次探测,
  // agy 的预检其实探的是别人的 host。现在各探各的;同一家第二次照样走缓存(按端点缓存)。
  it('agy and keyed Gemini use different Google hosts — each probed once, repeats are cached', async () => {
    const fetcher = okFetcher()
    const pf = makeCheapEvalPreflight({ fetcher, now: () => 1000 })
    await pf('agy'); await pf('gemini'); await pf('agy')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})
