import { describe, expect, it } from 'vitest'
import { makeJsEmbedder, withEmbedderFallback, defaultModelRepo, type FeatureExtractor } from './js-embedder'
import type { EmbedderService } from './embedder-service'

// Service semantics only — no model, no network. The vectors-are-equivalent
// property lives in js-embedder.e2e.test.ts, which needs a real model.

function fakeFactory(opts: { failTimes?: number; onCall?: () => void } = {}) {
  const calls: string[] = []
  let failsLeft = opts.failTimes ?? 0
  const extractor: FeatureExtractor = async (text) => {
    opts.onCall?.()
    const s = Array.isArray(text) ? text.join('') : text
    return { data: Float32Array.from([s.length, 1, 2]) }
  }
  const factory = async (model: string) => {
    calls.push(model)
    if (failsLeft > 0) { failsLeft--; throw new Error('load failed') }
    return extractor
  }
  return { factory, calls }
}

const base = { model_id: 'bge-small-zh-v1.5' }

describe('makeJsEmbedder', () => {
  it('defaults to the community ONNX repo — BAAI ships no ONNX weights', () => {
    expect(defaultModelRepo('bge-small-zh-v1.5')).toBe('Xenova/bge-small-zh-v1.5')
  })

  it('is lazy: constructing it loads no model', () => {
    const { factory, calls } = fakeFactory()
    makeJsEmbedder({ ...base, pipelineFactory: factory })
    expect(calls).toEqual([])
  })

  it('loads once and reuses across embeds', async () => {
    const { factory, calls } = fakeFactory()
    const svc = makeJsEmbedder({ ...base, pipelineFactory: factory })
    await svc.embed(['a'])
    await svc.embed(['bb'])
    expect(calls.length).toBe(1)
  })

  it('shares ONE load between concurrent callers rather than starting several', async () => {
    const { factory, calls } = fakeFactory()
    const svc = makeJsEmbedder({ ...base, pipelineFactory: factory })
    await Promise.all([svc.embed(['a']), svc.embed(['b']), svc.embed(['c'])])
    expect(calls.length).toBe(1)
  })

  it('embeds each text and returns one vector per input', async () => {
    const { factory } = fakeFactory()
    const svc = makeJsEmbedder({ ...base, pipelineFactory: factory })
    const v = await svc.embed(['a', 'bbb'])
    expect(v).toEqual([[1, 1, 2], [3, 1, 2]])
  })

  it('returns [] for no input without loading the model', async () => {
    const { factory, calls } = fakeFactory()
    const svc = makeJsEmbedder({ ...base, pipelineFactory: factory })
    expect(await svc.embed([])).toEqual([])
    expect(calls).toEqual([])
  })

  it('a failed load rejects the caller and can be retried', async () => {
    // The packaged desktop sidecar cannot dlopen onnxruntime's native binding
    // (see the module docstring), so a rejection here is a state callers must
    // be able to fall back from — and a first-fetch network failure should not
    // wedge the service permanently.
    const { factory, calls } = fakeFactory({ failTimes: 1 })
    const svc = makeJsEmbedder({ ...base, pipelineFactory: factory })
    await expect(svc.embed(['a'])).rejects.toThrow(/load failed/)
    await expect(svc.embed(['a'])).resolves.toEqual([[1, 1, 2]])
    expect(calls.length).toBe(2)
  })

  it('warm() loads the model, is idempotent, and never rejects', async () => {
    let embeds = 0
    const { factory } = fakeFactory({ onCall: () => { embeds++ } })
    const svc = makeJsEmbedder({ ...base, pipelineFactory: factory })
    await svc.warm()
    await svc.warm()
    expect(embeds).toBe(1)

    const broken = makeJsEmbedder({ ...base, pipelineFactory: async () => { throw new Error('no onnxruntime') } })
    await expect(broken.warm()).resolves.toBeUndefined()
  })

  it('a warmed model is reused by the next real embed', async () => {
    const { factory, calls } = fakeFactory()
    const svc = makeJsEmbedder({ ...base, pipelineFactory: factory })
    await svc.warm()
    await svc.embed(['real'])
    expect(calls.length).toBe(1)
  })
})

describe('withEmbedderFallback', () => {
  const svc = (name: string, fail = false): EmbedderService => ({
    model_id: name,
    embed: async (t) => { if (fail) throw new Error(`${name} unavailable`); return t.map(() => [1]) },
    warm: async () => {},
    close: async () => {},
  })

  it('uses the primary while it works', async () => {
    const s = withEmbedderFallback(svc('js'), svc('py'))
    expect(await s.embed(['a'])).toEqual([[1]])
  })

  it('switches to the fallback on the primary’s first failure', async () => {
    // The packaged sidecar case: onnxruntime's native binding cannot load,
    // and the knowledge face must keep working rather than go down with it.
    let reason: unknown
    const s = withEmbedderFallback(svc('js', true), svc('py'), e => { reason = e })
    expect(await s.embed(['a'])).toEqual([[1]])
    expect(String(reason)).toMatch(/js unavailable/)
  })

  it('does not retry the primary after switching', async () => {
    let jsCalls = 0
    const failing: EmbedderService = {
      model_id: 'js', warm: async () => {}, close: async () => {},
      embed: async () => { jsCalls++; throw new Error('js unavailable') },
    }
    const s = withEmbedderFallback(failing, svc('py'))
    await s.embed(['a'])
    await s.embed(['b'])
    expect(jsCalls).toBe(1)
  })

  it('propagates the error when there is no fallback to switch to', async () => {
    const s = withEmbedderFallback(svc('js', true), undefined)
    await expect(s.embed(['a'])).rejects.toThrow(/js unavailable/)
  })

  it('warm() still never rejects, even when everything fails', async () => {
    const s = withEmbedderFallback(svc('js', true), svc('py', true))
    await expect(s.warm()).resolves.toBeUndefined()
  })
})
