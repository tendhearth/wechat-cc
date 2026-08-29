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

  it('agy and gemini share the google endpoint — one probe serves both (cache by endpoint)', async () => {
    const fetcher = okFetcher()
    const pf = makeCheapEvalPreflight({ fetcher, now: () => 1000 })
    await pf('agy')
    await pf('gemini')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
