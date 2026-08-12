// src/core/knowledge/cycle.test.ts
//
// Knowledge Kernel T7' review (Finding 2 + Finding 4) — runKnowledgeCycle is
// the extracted body of the daemon's boot-backfill/periodic-tick closure.
// These tests drive it directly (no daemon/bootstrap needed) to cover:
//   (a) the indexer runs AFTER the adapter, same pass
//   (b) an adapter or indexer throw is swallowed — never surfaces out of
//       runKnowledgeCycle, so a bad tick can't kill the daemon's timer
//   (c) gating — no `runIndex` means indexing is skipped, adapter still runs
//   (d) the concurrency guard — a cycle already in flight makes an
//       overlapping call a no-op instead of running two passes at once
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runKnowledgeCycle, __resetKnowledgeCycleRunningForTests } from './cycle'
import { runIndexer } from './indexer'
import { openKnowledge, type KnowledgeStore } from './store'
import { makeEmbedderService } from './embedder-service'
import type { EmbedRunner, MakeEmbedRunnerOpts } from './embed-runner'

type LogLine = { tag: string; line: string; fields?: Record<string, unknown> }

function makeLogger(): { log: LogLine[]; fn: (tag: string, line: string, fields?: Record<string, unknown>) => void } {
  const log: LogLine[] = []
  return { log, fn: (tag, line, fields) => { log.push({ tag, line, fields }) } }
}

describe('runKnowledgeCycle', () => {
  beforeEach(() => {
    __resetKnowledgeCycleRunningForTests()
  })

  it('runs the indexer AFTER the adapter', async () => {
    const order: string[] = []
    const { fn } = makeLogger()
    const result = await runKnowledgeCycle(
      {
        runAdapter: async () => {
          order.push('adapter')
          return { ingested: 3 }
        },
        runIndex: async () => {
          order.push('indexer')
          return { indexed: 2 }
        },
        log: fn,
      },
      { onBoot: false },
    )
    expect(order).toEqual(['adapter', 'indexer'])
    expect(result).toEqual({ ingested: 3, skipped: false })
  })

  it('skips the indexer (but still runs the adapter) when runIndex is not provided', async () => {
    const order: string[] = []
    const { log, fn } = makeLogger()
    const result = await runKnowledgeCycle(
      {
        runAdapter: async () => {
          order.push('adapter')
          return { ingested: 1 }
        },
        // runIndex omitted — mirrors "no resolvable wxsearch plugin dir"
        log: fn,
      },
      { onBoot: true },
    )
    expect(order).toEqual(['adapter'])
    expect(result).toEqual({ ingested: 1, skipped: false })
    expect(log.find(l => l.line.includes('indexer disabled'))).toBeTruthy()
  })

  it('does not log "indexer disabled" on non-boot ticks (matches pre-extraction verbosity)', async () => {
    const { log, fn } = makeLogger()
    await runKnowledgeCycle(
      {
        runAdapter: async () => ({ ingested: 0 }),
        log: fn,
      },
      { onBoot: false },
    )
    expect(log.find(l => l.line.includes('indexer disabled'))).toBeUndefined()
  })

  it('swallows an adapter throw — does not reject, and still runs the indexer', async () => {
    const order: string[] = []
    const { log, fn } = makeLogger()
    const result = await runKnowledgeCycle(
      {
        runAdapter: async () => {
          order.push('adapter')
          throw new Error('adapter boom')
        },
        runIndex: async () => {
          order.push('indexer')
          return { indexed: 0 }
        },
        log: fn,
      },
      { onBoot: false },
    )
    expect(order).toEqual(['adapter', 'indexer'])
    expect(result.ingested).toBe(0)
    expect(log.find(l => l.line.includes('adapter run failed'))).toBeTruthy()
  })

  it('swallows an indexer throw — does not reject', async () => {
    const { log, fn } = makeLogger()
    const result = await runKnowledgeCycle(
      {
        runAdapter: async () => ({ ingested: 5 }),
        runIndex: async () => {
          throw new Error('indexer boom')
        },
        log: fn,
      },
      { onBoot: false },
    )
    expect(result).toEqual({ ingested: 5, skipped: false })
    expect(log.find(l => l.line.includes('indexer run failed'))).toBeTruthy()
  })

  it('a second call while the first is in-flight is a no-op (concurrency guard)', async () => {
    const { log, fn } = makeLogger()
    let adapterCalls = 0
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })

    const first = runKnowledgeCycle(
      {
        runAdapter: async () => {
          adapterCalls++
          await gate // hold the first cycle "in flight"
          return { ingested: 1 }
        },
        log: fn,
      },
      { onBoot: false },
    )

    // Fired while `first` is still awaiting the gate.
    const second = await runKnowledgeCycle(
      {
        runAdapter: async () => {
          adapterCalls++
          return { ingested: 99 }
        },
        log: fn,
      },
      { onBoot: false },
    )

    expect(second).toEqual({ ingested: 0, skipped: true })
    expect(adapterCalls).toBe(1) // second call's runAdapter never invoked
    expect(log.find(l => l.line.includes('cycle skipped'))).toBeTruthy()

    release()
    const firstResult = await first
    expect(firstResult).toEqual({ ingested: 1, skipped: false })

    // Guard released after the first cycle settles — a third call now runs.
    const third = await runKnowledgeCycle(
      {
        runAdapter: async () => {
          adapterCalls++
          return { ingested: 7 }
        },
        log: fn,
      },
      { onBoot: false },
    )
    expect(third).toEqual({ ingested: 7, skipped: false })
    expect(adapterCalls).toBe(2)
  })
})

// ── Agent-facing Search Task 2 — ONE shared embedder across cycles ────────
// bootstrap/index.ts now constructs `embedder` (makeEmbedderService) ONCE,
// builds ONE `runIndex` closure over it, and hands that SAME closure to
// every call of runKnowledgeCycle (boot backfill + every periodic tick) —
// never a fresh embedder/subprocess per cycle, and never closed until
// daemon shutdown. These tests reproduce that exact wiring shape (a real
// KnowledgeStore + a real runIndexer, but a fake embed subprocess) to prove
// the closure-reuse contract directly, rather than only reachable through
// full daemon bootstrap.

/** A fake runner: `embed` records the texts it was called with; `close`
 *  counts its calls. Mirrors embedder-service.test.ts's fixture. */
function makeFakeRunner() {
  const state = { embedCalls: [] as string[][], closeCalls: 0 }
  const runner: EmbedRunner = {
    async embed(texts: string[]) {
      state.embedCalls.push(texts)
      return texts.map(t => [t.length, 1, 2])
    },
    async close() {
      state.closeCalls++
    },
  }
  return { runner, state }
}

/** A spy `makeRunner`: hands out `runners` in order; throws if called more
 *  times than configured (proves "no respawn" when only one is supplied). */
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

describe('runKnowledgeCycle + a shared embedder (Agent-facing Search Task 2)', () => {
  let dir: string
  let store: KnowledgeStore

  beforeEach(() => {
    __resetKnowledgeCycleRunningForTests()
    dir = mkdtempSync(join(tmpdir(), 'kk-cycle-embedder-'))
    store = openKnowledge(dir)
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('a runIndex closure built over ONE shared embedder, reused across two cycles, embeds with that embedder\'s model_id and is never closed between cycles', async () => {
    const { runner, state } = makeFakeRunner()
    const { fn: makeRunner, calls } = makeMakeRunnerSpy([runner])

    // Mirrors bootstrap/index.ts's wiring exactly: ONE embedder built
    // outside the cycle closure, and ONE runIndex closure built over it
    // (never rebuilt per cycle) — the same closure is what both the boot
    // backfill and every periodic tick call pass as deps.runIndex.
    const embedder = makeEmbedderService({
      pythonBin: 'python3',
      scriptPath: '/fake/embed.py',
      model_id: 'bge-small-zh-v1.5',
      makeRunner,
    })
    const runIndex = () => runIndexer({
      store,
      embed: embedder.embed,
      model_id: embedder.model_id,
      model_version: 'v1',
    })
    const { fn: log } = makeLogger()

    store.putSourceMessages([
      { msg_key: 'm1', conversation: 'c1', sender: 's1', time: 1, type: 'text', text: 'hello', server_id: '' },
    ])
    const first = await runKnowledgeCycle(
      { runAdapter: async () => ({ ingested: 0 }), runIndex, log },
      { onBoot: true },
    )
    expect(first.skipped).toBe(false)
    // Both the embed call and the semantic-store provenance tag used the
    // SHARED embedder's model_id, not some separately-threaded config value.
    expect(state.embedCalls).toEqual([['hello']])
    expect(store.countSemantic('bge-small-zh-v1.5')).toBe(1)
    expect(calls.length).toBe(1) // one subprocess spawned so far
    // NOT closed between cycles — Task 2's whole point (the pre-Task-2
    // behavior closed a fresh embed runner in a `finally` after every cycle).
    expect(state.closeCalls).toBe(0)

    // Second cycle — a new source message, the SAME runIndex closure (same
    // captured `embedder`), standing in for the next periodic tick.
    store.putSourceMessages([
      { msg_key: 'm2', conversation: 'c1', sender: 's1', time: 2, type: 'text', text: 'world', server_id: '' },
    ])
    const second = await runKnowledgeCycle(
      { runAdapter: async () => ({ ingested: 0 }), runIndex, log },
      { onBoot: false },
    )
    expect(second.skipped).toBe(false)
    expect(state.embedCalls).toEqual([['hello'], ['world']])
    expect(store.countSemantic('bge-small-zh-v1.5')).toBe(2)
    // Still ONE spawned subprocess — makeRunner was never called again, so
    // the second cycle reused the shared embedder instance instead of
    // spawning a fresh one (makeMakeRunnerSpy would throw otherwise).
    expect(calls.length).toBe(1)
    expect(state.closeCalls).toBe(0)
  })
})
