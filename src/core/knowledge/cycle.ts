// src/core/knowledge/cycle.ts
//
// Knowledge Kernel — one backfill/tick cycle: run the source adapter, then
// (if indexing is configured) run the indexer's embed pass. Extracted out of
// daemon/bootstrap/index.ts's inline `runKnowledgeAdapter` closure (T7'
// review Finding 2) so the actual scheduling behavior — adapter-then-
// indexer ordering, error-swallowing, and the concurrency guard (Finding 4)
// — has direct unit coverage instead of only being reachable indirectly
// through buildBootstrap's full daemon wiring (which needs a resolvable
// wxsearch plugin dir + real script to exercise the indexer path at all).
//
// The bootstrap wiring calls this from two places with the exact same
// deps — a one-shot boot backfill (`setTimeout(0)`, deferred so it never
// delays buildBootstrap's return) and a periodic tick (`setInterval`, every
// 5 min). Both closures are cheap to build fresh each call (they just close
// over the already-open KnowledgeStore + embed script/interpreter paths).

export interface RunKnowledgeCycleDeps {
  /** Runs the source adapter against the already-open KnowledgeStore;
   *  returns how many source rows it ingested this pass. */
  runAdapter: () => { ingested: number } | Promise<{ ingested: number }>
  /**
   * Runs the indexer over the daemon's shared, long-lived embedder service
   * (constructed once at boot, used by BOTH the indexer and the query path,
   * closed only on daemon shutdown) — NOT a per-cycle spawn/close.
   * `undefined` when indexing isn't configured (e.g. no resolvable wxsearch
   * plugin dir and no `knowledge_embed_script` override) — the adapter
   * still runs in that case; indexing is just skipped.
   */
  runIndex?: () => Promise<{ indexed: number }>
  /**
   * Knowledge Graph inproc Task 4 — rebuilds the in-proc contact/edge graph
   * (graph.db, via `graph-build.ts`'s `rebuildGraphFromSource`) from
   * whatever source is now in the store. Runs AFTER the indexer, same pass,
   * same error-swallowing posture as `runAdapter`/`runIndex` below — a
   * broken or slow rebuild must never crash the cycle or block the next
   * tick. `undefined` when the graph layer isn't wired (mirrors `runIndex`'s
   * own optionality) — the adapter/indexer still run in that case; the
   * rebuild is just skipped. The rebuild itself owns its own incremental
   * gate (skips when source hasn't advanced since the last build) — this
   * dep is called every cycle regardless; whether that call does real work
   * is `rebuildGraphFromSource`'s decision, not this module's.
   */
  runGraphRebuild?: () => RunGraphRebuildResult | Promise<RunGraphRebuildResult>
  log: (tag: string, line: string, fields?: Record<string, unknown>) => void
}

/** Structural subset of graph-build.ts's `RebuildGraphFromSourceResult` that
 *  this module actually reads (just for logging) — kept local rather than
 *  importing that type so cycle.ts's dependency surface stays the same
 *  shape as `runAdapter`/`runIndex` (a plain result shape, not a coupling to
 *  graph-build.ts's own type). */
export interface RunGraphRebuildResult {
  owner: string | null
  contacts: number
  edges: number
  skipped: boolean
}

export interface RunKnowledgeCycleOpts {
  /** True for the one-shot boot backfill, false for periodic ticks — only
   *  affects logging verbosity, mirroring the pre-extraction behavior
   *  (boot always logs; ticks only log the indexer line when it did work). */
  onBoot: boolean
}

export interface RunKnowledgeCycleResult {
  ingested: number
  /** True when this call was a no-op because a previous cycle was still
   *  in flight (the concurrency guard, T7' review Finding 4). */
  skipped: boolean
}

// Module-level guard: a long first backfill overlapping the next periodic
// tick must not run two concurrent adapter+indexer passes against the same
// store (and spawn two embed subprocesses). A single flag is enough because
// the daemon only ever runs one knowledge cycle scheduler per process.
let knowledgeCycleRunning = false

export async function runKnowledgeCycle(
  deps: RunKnowledgeCycleDeps,
  opts: RunKnowledgeCycleOpts,
): Promise<RunKnowledgeCycleResult> {
  if (knowledgeCycleRunning) {
    deps.log('KNOWLEDGE', 'cycle skipped — previous cycle still running')
    return { ingested: 0, skipped: true }
  }

  knowledgeCycleRunning = true
  try {
    let ingested = 0
    try {
      ingested = (await deps.runAdapter()).ingested
      if (opts.onBoot) deps.log('BOOT', 'knowledge: enabled — store + source adapter wired', { ingested })
    } catch (err) {
      deps.log('KNOWLEDGE', `source adapter run failed: ${err instanceof Error ? err.message : String(err)}`)
    }

    // Indexer runs AFTER the adapter (regardless of whether the adapter
    // succeeded), same schedule, so each pass indexes whatever `source` the
    // adapter just normalized. `runIndex` rejecting (e.g. from a killed/
    // broken embed runner) aborts mid-run WITHOUT advancing the indexer's
    // store-meta cursor — the next cycle retries from the same point,
    // exactly like the adapter's own crash-safety story above.
    if (deps.runIndex) {
      try {
        const { indexed } = await deps.runIndex()
        if (opts.onBoot || indexed > 0) deps.log('KNOWLEDGE', `indexer run: ${indexed} chunk(s) embedded`, { indexed })
      } catch (err) {
        deps.log('KNOWLEDGE', `indexer run failed (will retry next tick): ${err instanceof Error ? err.message : String(err)}`)
      }
    } else if (opts.onBoot) {
      deps.log('KNOWLEDGE', 'indexer disabled — wxsearch plugin not found; set knowledge_embed_script to point at embed_subprocess.py')
    }

    // Graph rebuild runs AFTER the indexer, same pass — same throw-safety
    // and boot/non-boot logging-verbosity posture as the two steps above.
    // `runGraphRebuild` omitted (graph layer not wired) is silently fine,
    // same as `runIndex` omitted above.
    if (deps.runGraphRebuild) {
      try {
        const result = await deps.runGraphRebuild()
        if (opts.onBoot || !result.skipped) {
          deps.log(
            'KNOWLEDGE',
            result.skipped
              ? 'graph rebuild: skipped (no new source since last build)'
              : `graph rebuild: ${result.contacts} contact(s), ${result.edges} edge(s)`,
            { owner: result.owner, contacts: result.contacts, edges: result.edges, skipped: result.skipped },
          )
        }
      } catch (err) {
        deps.log('KNOWLEDGE', `graph rebuild failed (will retry next tick): ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    return { ingested, skipped: false }
  } finally {
    knowledgeCycleRunning = false
  }
}

/**
 * Test-only escape hatch. `knowledgeCycleRunning` is deliberately
 * module-level singleton state (mirrors production: one daemon process, one
 * knowledge scheduler) — but that means it's also shared across every test
 * that imports this module within the same `bun test` process. Call this in
 * a `beforeEach`/`afterEach` to keep tests independent.
 */
export function __resetKnowledgeCycleRunningForTests(): void {
  knowledgeCycleRunning = false
}
