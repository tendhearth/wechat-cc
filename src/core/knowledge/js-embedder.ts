/**
 * js-embedder — in-process embeddings via transformers.js, an alternative to
 * the Python `embed_subprocess.py` behind the same `EmbedderService` shape.
 *
 * Why: the Python path costs a 175MB venv, a setup step, and a cross-language
 * process boundary that produced three bugs in a single day (bare-script
 * relative imports, the runner swallowing the subprocess's error, and a cold
 * model load that no in-process warm-up could reach). In-process it is ~5ms
 * per warm embed and the model can be warmed directly.
 *
 * Vector equivalence is the reason a migration is even possible without
 * re-indexing: measured cosine 0.99999887–0.99999927 against the Python
 * output for the same model, versus 0.12–0.28 for unrelated text. See
 * js-embedder.e2e.test.ts, which pins Python reference vectors.
 *
 * Two deliberate constraints:
 *
 *  - The model repo is `Xenova/bge-small-zh-v1.5`, NOT `BAAI/...`. The
 *    official repo ships no ONNX weights and transformers.js cannot load it;
 *    the Python side's `Qdrant/...` is likewise not loadable here. This adds
 *    a dependency on a community conversion — recorded rather than hidden.
 *
 *  - `load()` can fail and that must be survivable. In the packaged desktop
 *    app the sidecar is a `bun build --compile` single file, and
 *    onnxruntime's native binding cannot be dlopen'd from there (its
 *    `libonnxruntime.dylib` is not extracted alongside it). Callers get a
 *    rejected promise and are expected to fall back, not crash.
 */

import type { EmbedderService } from './embedder-service.ts'

/** The slice of transformers.js this module uses, so tests can supply it. */
export type FeatureExtractor = (
  text: string | string[],
  opts: { pooling: 'cls' | 'mean'; normalize: boolean },
) => Promise<{ data: Float32Array | number[]; dims?: number[] }>

export type PipelineFactory = (model: string) => Promise<FeatureExtractor>

export interface MakeJsEmbedderOpts {
  model_id: string
  /** Model repo to load. Defaults to the community ONNX conversion of
   *  `model_id` — see the module docstring for why it cannot be BAAI's. */
  modelRepo?: string
  /** Injected for tests; defaults to a dynamic import of transformers.js so
   *  a daemon that never selects this runtime never pays to load it. */
  pipelineFactory?: PipelineFactory
}

const DEFAULT_REPOS: Record<string, string> = {
  'bge-small-zh-v1.5': 'Xenova/bge-small-zh-v1.5',
}

export function defaultModelRepo(model_id: string): string {
  return DEFAULT_REPOS[model_id] ?? `Xenova/${model_id}`
}

export const defaultPipelineFactory: PipelineFactory = async (model) => {
  // Dynamic so the import cost (and its native binding) is only paid when
  // this runtime is actually selected.
  const { pipeline } = await import('@huggingface/transformers')
  const extractor = await pipeline('feature-extraction', model, { dtype: 'fp32' })
  return extractor as unknown as FeatureExtractor
}

export function makeJsEmbedder(opts: MakeJsEmbedderOpts): EmbedderService {
  const factory = opts.pipelineFactory ?? defaultPipelineFactory
  const repo = opts.modelRepo ?? defaultModelRepo(opts.model_id)
  let extractorPromise: Promise<FeatureExtractor> | null = null

  function load(): Promise<FeatureExtractor> {
    // Cached as the PROMISE, not the result: concurrent callers during a slow
    // first load must share one load rather than start several.
    if (!extractorPromise) {
      extractorPromise = factory(repo).catch(err => {
        // Drop the cache so a later call can retry — a failed load is often
        // transient (no network for the first model fetch).
        extractorPromise = null
        throw err
      })
    }
    return extractorPromise
  }

  async function embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []
    const extractor = await load()
    const out: number[][] = []
    for (const t of texts) {
      // `cls` pooling + normalize matches what the Python runner produces for
      // this model family; the equivalence test is what actually holds this
      // to account.
      const r = await extractor(t, { pooling: 'cls', normalize: true })
      out.push(Array.from(r.data as Float32Array))
    }
    return out
  }

  let warmed = false
  async function warm(): Promise<void> {
    if (warmed) return
    warmed = true
    try { await embed(['warm']) } catch { /* see EmbedderService.warm's contract */ }
  }

  async function close(): Promise<void> {
    // transformers.js holds an ONNX session with no public disposal in v4;
    // dropping the reference is all we can do. Kept so this is a drop-in for
    // the subprocess-backed service, whose close() ends a real child.
    extractorPromise = null
  }

  return { model_id: opts.model_id, embed, warm, close }
}

/**
 * Run `primary`, and on its first failure switch permanently to `fallback`.
 *
 * Exists for one concrete case: selecting the JS runtime inside the packaged
 * desktop sidecar, where onnxruntime's native binding cannot be dlopen'd from
 * a compiled single file. Without this, choosing 'js' there would take the
 * whole knowledge face down instead of quietly using the runtime that does
 * work. The switch is permanent rather than per-call because the failure it
 * guards is structural (no native binding) — retrying it on every embed would
 * pay the load cost forever for something that cannot start.
 *
 * With no fallback available the error propagates unchanged; a caller that
 * asked for JS on a machine with nothing else deserves to see why it failed.
 */
export function withEmbedderFallback(
  primary: EmbedderService,
  fallback: EmbedderService | undefined,
  onFallback?: (err: unknown) => void,
): EmbedderService {
  if (!fallback) return primary
  let active = primary
  let switched = false

  async function embed(texts: string[]): Promise<number[][]> {
    try {
      return await active.embed(texts)
    } catch (err) {
      if (switched) throw err
      switched = true
      active = fallback!
      onFallback?.(err)
      return active.embed(texts)
    }
  }

  return {
    model_id: primary.model_id,
    embed,
    warm: async () => { try { await embed(['warm']) } catch { /* warm never rejects */ } },
    close: async () => { await primary.close(); await fallback!.close() },
  }
}
