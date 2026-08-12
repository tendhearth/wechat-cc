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
import { describe, it, expect, beforeEach } from 'vitest'
import { runKnowledgeCycle, __resetKnowledgeCycleRunningForTests } from './cycle'

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
