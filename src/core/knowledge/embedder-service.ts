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

  return {
    model_id: opts.model_id,
    embed,
    close,
  }
}
