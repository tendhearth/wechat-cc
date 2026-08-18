// src/core/knowledge/embedder-service.test.ts
//
// Knowledge Kernel — Agent-facing Search Task 1. `makeEmbedderService` wraps
// `makeEmbedRunner` as a lazy, respawn-on-death singleton: no subprocess
// until the first `embed()` call, one runner reused across calls, a dead
// runner (its `embed` rejects) is dropped so the NEXT call gets a fresh one,
// and `close()` tears the runner down (a later `embed()` respawns). This
// test injects a fake `makeRunner` — no real Python/model involved.
import { describe, it, expect } from 'vitest'
import { makeEmbedderService } from './embedder-service'
import type { EmbedRunner, MakeEmbedRunnerOpts } from './embed-runner'

/** A fake runner: `embed` records the texts it was called with (and either
 *  returns a fixed vector per text or runs a caller-supplied impl, e.g. one
 *  that rejects to simulate child death); `close` counts its calls. */
function makeFakeRunner(embedImpl?: (texts: string[]) => Promise<number[][]>) {
  const state = { embedCalls: [] as string[][], closeCalls: 0 }
  const runner: EmbedRunner = {
    async embed(texts: string[]) {
      state.embedCalls.push(texts)
      if (embedImpl) return embedImpl(texts)
      return texts.map(t => [t.length, 1, 2])
    },
    async close() {
      state.closeCalls++
    },
  }
  return { runner, state }
}

/** A spy `makeRunner`: each call hands out the next runner from `runners`
 *  (in order) and records the opts it was invoked with. Throws if called
 *  more times than runners were configured — a test bug, not expected
 *  behavior. */
function makeMakeRunnerSpy(runners: EmbedRunner[]) {
  const calls: MakeEmbedRunnerOpts[] = []
  const fn = (opts: MakeEmbedRunnerOpts): EmbedRunner => {
    calls.push(opts)
    const r = runners[calls.length - 1]
    if (!r) throw new Error(`makeRunner called more times (${calls.length}) than fake runners configured (${runners.length})`)
    return r
  }
  return { fn, calls }
}

const baseOpts = { pythonBin: 'python3', scriptPath: '/fake/embed.py', model_id: 'bge-m3' }

describe('makeEmbedderService', () => {
  it('LAZY: does not spawn a runner until the first embed() call', () => {
    const { runner } = makeFakeRunner()
    const { fn, calls } = makeMakeRunnerSpy([runner])
    makeEmbedderService({ ...baseOpts, makeRunner: fn })
    expect(calls.length).toBe(0)
  })

  it('REUSE: two embed() calls use ONE runner', async () => {
    const { runner } = makeFakeRunner()
    const { fn, calls } = makeMakeRunnerSpy([runner])
    const svc = makeEmbedderService({ ...baseOpts, makeRunner: fn })

    await svc.embed(['a'])
    await svc.embed(['b'])

    expect(calls.length).toBe(1)
  })

  it('RESPAWN: a runner whose embed() rejects (child death) is dropped, and the next embed() spawns a fresh one and succeeds', async () => {
    const { runner: dying } = makeFakeRunner(async () => {
      throw new Error('embed subprocess died')
    })
    const { runner: fresh, state: freshState } = makeFakeRunner()
    const { fn, calls } = makeMakeRunnerSpy([dying, fresh])
    const svc = makeEmbedderService({ ...baseOpts, makeRunner: fn })

    await expect(svc.embed(['a'])).rejects.toThrow('embed subprocess died')
    expect(calls.length).toBe(1)

    const vectors = await svc.embed(['bb'])

    expect(calls.length).toBe(2)
    expect(vectors).toEqual([[2, 1, 2]])
    expect(freshState.embedCalls).toEqual([['bb']])
  })

  it('NO-LEAK: a dropped (rejecting) runner is close()d so a still-live child cannot leak', async () => {
    // Some rejections (a stray stdout line -> JSON.parse throw, a vector-count
    // mismatch) do NOT kill the embed child. The service must close() the
    // dropped runner, or that live model subprocess leaks (a fresh one spawns
    // on the next call). close() is best-effort/fire-and-forget in the catch.
    const { runner: bad, state: badState } = makeFakeRunner(async () => {
      throw new Error('stray stdout: not JSON')
    })
    const { runner: fresh } = makeFakeRunner()
    const { fn } = makeMakeRunnerSpy([bad, fresh])
    const svc = makeEmbedderService({ ...baseOpts, makeRunner: fn })

    await expect(svc.embed(['a'])).rejects.toThrow('stray stdout')
    // let the fire-and-forget close() microtask settle
    await Promise.resolve()
    expect(badState.closeCalls).toBe(1)
    // and the next call still respawns fresh
    expect(await svc.embed(['bb'])).toEqual([[2, 1, 2]])
  })

  it('CLOSE: close() calls the runner\'s close(); an embed() after close respawns', async () => {
    const { runner: r1, state: s1 } = makeFakeRunner()
    const { runner: r2 } = makeFakeRunner()
    const { fn, calls } = makeMakeRunnerSpy([r1, r2])
    const svc = makeEmbedderService({ ...baseOpts, makeRunner: fn })

    await svc.embed(['a'])
    expect(calls.length).toBe(1)

    await svc.close()
    expect(s1.closeCalls).toBe(1)

    await svc.embed(['b'])
    expect(calls.length).toBe(2)
  })

  it('close() before any embed() call is a no-op (never calls makeRunner)', async () => {
    const { fn, calls } = makeMakeRunnerSpy([])
    const svc = makeEmbedderService({ ...baseOpts, makeRunner: fn })

    await expect(svc.close()).resolves.toBeUndefined()
    expect(calls.length).toBe(0)
  })

  it('exposes model_id from opts', () => {
    const svc = makeEmbedderService({
      ...baseOpts,
      model_id: 'bge-m3-custom',
      makeRunner: () => {
        throw new Error('makeRunner should not be called just to read model_id')
      },
    })
    expect(svc.model_id).toBe('bge-m3-custom')
  })

  // Cold-start warm-up. The model loads on the FIRST embed(), and at boot the
  // indexer often has nothing new to index — it logged `0 chunk(s) embedded`
  // and never called embed() — so nothing loaded the model until a user query
  // arrived. hearth's federated client gives a source 5s; loading a 90MB ONNX
  // model does not fit in 5s, so the first federated query after every daemon
  // restart timed out and reported "no results", indistinguishable from a
  // genuine miss. Verified on the live daemon: first query 5801ms/timeout/0
  // hits, second 396ms/20 hits.
  describe('warm()', () => {
    it('forces the model to load by issuing one embed', async () => {
      const { runner, state } = makeFakeRunner()
      const { fn, calls } = makeMakeRunnerSpy([runner])
      const svc = makeEmbedderService({ ...baseOpts, makeRunner: fn })

      await svc.warm()

      expect(calls.length).toBe(1)
      expect(state.embedCalls.length).toBe(1)
    })

    it('a later embed() reuses the warmed runner rather than paying again', async () => {
      const { runner, state } = makeFakeRunner()
      const { fn, calls } = makeMakeRunnerSpy([runner])
      const svc = makeEmbedderService({ ...baseOpts, makeRunner: fn })

      await svc.warm()
      await svc.embed(['real text'])

      expect(calls.length).toBe(1)
      expect(state.embedCalls.length).toBe(2)
    })

    it('is idempotent — warming twice does not spawn or embed twice', async () => {
      const { runner, state } = makeFakeRunner()
      const { fn } = makeMakeRunnerSpy([runner])
      const svc = makeEmbedderService({ ...baseOpts, makeRunner: fn })

      await svc.warm()
      await svc.warm()

      expect(state.embedCalls.length).toBe(1)
    })

    it('never rejects — a broken embedder must not take the daemon down at boot', async () => {
      // warm() is called fire-and-forget from bootstrap; an unhandled
      // rejection there would surface as a boot-time crash for a purely
      // optional optimisation.
      const runner = { embed: async () => { throw new Error('model download failed') }, close: async () => {} }
      const { fn } = makeMakeRunnerSpy([runner as never])
      const svc = makeEmbedderService({ ...baseOpts, makeRunner: fn })

      await expect(svc.warm()).resolves.toBeUndefined()
    })
  })
})
