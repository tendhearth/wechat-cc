// src/core/knowledge/embedder-service.ts
//
// Knowledge Kernel — Agent-facing Search Task 1. `makeEmbedderService`
// wraps `makeEmbedRunner` (a single persistent embed subprocess, see
// ./embed-runner's module docstring) as a lazy, respawn-on-death singleton
// shared by the indexer AND the query path (Task 2/3), so both embed in the
// same model space via the same `model_id`.
//
// Lifecycle:
//   - No subprocess is spawned until the first embed() call (lazy).
//   - The runner is reused across calls (one child process, not one per
//     request — makeEmbedRunner already serializes concurrent embed()
//     calls onto its single stdin/stdout pipe).
//   - If a request against the current runner rejects (child died, timed
//     out, etc. — see embed-runner's `broken` handling), the runner is
//     dropped so the NEXT embed() call transparently spawns a fresh one.
//   - close() tears down the current runner (if any); a later embed() call
//     respawns.
import { makeEmbedRunner, type MakeEmbedRunnerOpts } from './embed-runner'

export interface MakeEmbedderServiceOpts {
  pythonBin: string
  scriptPath: string
  model_id: string
  env?: Record<string, string | undefined>
  timeoutMs?: number
  /** Injectable for tests — production omits this and gets the real
   *  `makeEmbedRunner` (a real spawned Python subprocess). */
  makeRunner?: typeof makeEmbedRunner
}

export interface EmbedderService {
  model_id: string
  embed(texts: string[]): Promise<number[][]>
  /**
   * Load the model now, so the first real caller does not pay for it.
   *
   * The model loads on the first `embed()`. At boot the indexer frequently
   * has nothing new — it logs `0 chunk(s) embedded` without calling embed at
   * all — so nothing loaded the model until a user query arrived. hearth's
   * federated client allows a source 5s, and loading a 90MB ONNX model does
   * not fit in 5s, so the first federated query after every daemon restart
   * timed out and reported "no results", which is indistinguishable from a
   * genuine miss. Measured on the live daemon: first query 5801ms → timeout →
   * 0 hits; second query 396ms → 20 hits.
   *
   * Never rejects: bootstrap calls this fire-and-forget, and an optional
   * optimisation must not be able to fail a boot.
   */
  warm(): Promise<void>
  close(): Promise<void>
}

export function makeEmbedderService(opts: MakeEmbedderServiceOpts): EmbedderService {
  const makeRunner = opts.makeRunner ?? makeEmbedRunner
  let runner: ReturnType<typeof makeEmbedRunner> | null = null

  function spawnRunner(): ReturnType<typeof makeEmbedRunner> {
    const runnerOpts: MakeEmbedRunnerOpts = {
      pythonBin: opts.pythonBin,
      scriptPath: opts.scriptPath,
      model_id: opts.model_id,
      env: opts.env,
      requestTimeoutMs: opts.timeoutMs,
    }
    return makeRunner(runnerOpts)
  }

  async function embed(texts: string[]): Promise<number[][]> {
    if (!runner) {
      runner = spawnRunner()
    }
    const current = runner
    try {
      return await current.embed(texts)
    } catch (e) {
      // Drop the runner (however it died — rejection, timeout, "broken"
      // guard in embed-runner) so the NEXT embed() call respawns a fresh
      // subprocess instead of continuing to hit a dead/wedged one.
      // Best-effort close the dropped runner FIRST: some rejections
      // (JSON-parse of a stray stdout line, vector-count mismatch) do NOT
      // kill the child — without this, that live model subprocess would leak
      // (a fresh one spawns on the next call). Fire-and-forget; close() ends
      // stdin so a live child exits cleanly, a dead one is a no-op.
      runner = null
      void current.close().catch(() => {})
      throw e
    }
  }

  async function close(): Promise<void> {
    if (runner) {
      const current = runner
      runner = null
      await current.close()
    }
  }

  let warmed = false
  async function warm(): Promise<void> {
    if (warmed) return
    warmed = true
    try {
      // One tiny embed is enough — the cost being paid here is the model
      // load inside the subprocess, not the tokens.
      await embed(['warm'])
    } catch {
      // Swallowed on purpose. A failure here (no model yet, no network,
      // broken script) must not surface as a boot error; the next real
      // embed() will hit the same failure and report it where it matters.
      // Left `warmed = true` so a permanently broken embedder is not
      // retried on every subsequent warm() call.
    }
  }

  return {
    model_id: opts.model_id,
    embed,
    warm,
    close,
  }
}
