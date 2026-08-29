/**
 * One ingest cycle: freshen decryption, run staleness-gated deterministic
 * builders, then drain a bounded slice of wxfacts extraction. All plugin work
 * goes through the MCP bridge (no agent turn); the LLM appears only inside
 * `runExtraction`. Each step is guarded by `hasTool` so a source that isn't
 * loaded/ready is simply skipped — the cycle degrades per-source, never throws.
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { runExtraction } from './extract'
import { runConflictSweep } from './sweep-conflicts'
import { runObligationDedup } from './sweep-obligation-dupes'
import { runSettlementBackfill } from './sweep-obligation-settled'
import { makeInProcFactsCall } from './facts-inproc'
import type { FactsApi } from '../../../core/knowledge/facts'

export interface IngestBridge {
  call: (tool: string, input?: unknown) => Promise<string>
}

export interface CycleDeps {
  bridge: IngestBridge
  /** Is this plugin tool present + ready (from bridge.tools)? */
  hasTool: (tool: string) => boolean
  cheapEval: (prompt: string) => Promise<string>
  /** Max mtime (ms) of the decrypted source dbs; 0 if none. */
  sourceMaxMtime: () => number
  /** Source mtime processed by the previous cycle (in-memory across cycles). */
  lastSourceMtime: number
  /** Per-cycle extraction batch cap. */
  cap: number
  log?: (tag: string, msg: string) => void
  /**
   * When present, extraction is driven off the in-process FactsApi instead of
   * the MCP bridge (the wxfacts plugin is retired) — runs unconditionally,
   * bypassing `hasTool('extraction_batch')`, since facts always "has" the
   * tool. When absent, falls back to the pre-existing `bridge`/`hasTool` path.
   */
  factsApi?: FactsApi
  /** Cross-cycle builder failure streaks (caller-owned, in-memory) — enables
   *  the repeat-timeout cooldown below. Absent ⇒ builders always attempted. */
  builderHealth?: BuilderHealth
  /** Injectable clock for the cooldown (tests). */
  now?: () => number
}

/** Per-builder consecutive-failure streaks. Keep ONE instance across cycles. */
export interface BuilderHealth {
  fails: Map<string, { n: number; skipUntil: number }>
}

/** Consecutive failures before a builder is put on cooldown. */
export const BUILDER_FAILS_BEFORE_COOLDOWN = 3
/** How long a cooling-down builder is skipped. A wedged wxmedia model load
 *  times out at the MCP layer INSIDE runExclusive — each attempt can hold up
 *  an inbound message for the full request timeout, so after 3 straight
 *  failures we stop paying that toll every cycle. */
export const BUILDER_COOLDOWN_MS = 2 * 3600_000

/** Stock-conflict groups judged per ingest cycle — one cheapEval covers all of them. */
const SWEEP_GROUPS_PER_CYCLE = 5
/** Obligation-dedup contacts judged per cycle — one cheapEval each. */
const DEDUP_CONTACTS_PER_CYCLE = 2
/** Settlement-backfill contacts judged per cycle — one cheapEval each. */
const SETTLE_CONTACTS_PER_CYCLE = 2

export interface CycleReport {
  decrypted: boolean
  rebuilt: boolean
  indexed: boolean
  transcribed: boolean
  batches: number
  recorded: number
  /** Stock-conflict sweep: groups judged / facts superseded this cycle (0/0 when no in-proc facts store). */
  sweptGroups: number
  sweptSuperseded: number
  /** Obligation-dedup sweep: contacts judged / duplicates merged this cycle. */
  dedupContacts: number
  dedupMerged: number
  /** Obligation settlement: promises the chat showed as done, auto-resolved
   *  this cycle (per-batch step + stock backfill combined). */
  settled: number
  /** Settlement backfill: contacts whose recent chat was judged this cycle. */
  settleContacts: number
  /** The source mtime observed this cycle; the caller stores it as next lastSourceMtime. */
  newSourceMtime: number
}

/** Max mtime (ms) of wxvault's decrypted message dbs, or 0 if none exist. */
export function maxDecryptedMtime(stateDir: string): number {
  const dir = join(stateDir, 'plugin-data', 'wxvault', 'out', 'decrypted')
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return 0   // dir absent (no decrypted output yet)
  }
  let max = 0
  for (const name of names) {
    if (!name.endsWith('.sqlite')) continue
    try {
      const m = statSync(join(dir, name)).mtimeMs
      if (m > max) max = m
    } catch { /* file vanished mid-scan */ }
  }
  return max
}

/**
 * Build the cycle's `hasTool` predicate. Gates `extraction_batch` off when the
 * LLM is unavailable (`canExtract=false`) — otherwise the extraction loop would
 * pull real message windows, feed them to a stub, record `[]`, and PERMANENTLY
 * advance the watermark past un-extracted messages (silent data loss). With the
 * gate, extraction is simply skipped until a cheap-eval provider exists.
 */
export function ingestHasTool(toolNames: string[], canExtract: boolean): (t: string) => boolean {
  const set = new Set(toolNames)
  return (t) => (t === 'extraction_batch' && !canExtract) ? false : set.has(t)
}

async function tryBuild(d: CycleDeps, tool: string): Promise<boolean> {
  if (!d.hasTool(tool)) return false
  const now = d.now?.() ?? Date.now()
  const streak = d.builderHealth?.fails.get(tool)
  if (streak && streak.skipUntil > now) return false   // cooling down — skip silently
  try {
    await d.bridge.call(tool)
    d.builderHealth?.fails.delete(tool)                // success wipes the streak
    return true
  } catch (e) {
    if (d.builderHealth) {
      const n = (streak?.n ?? 0) + 1
      const cooldown = n >= BUILDER_FAILS_BEFORE_COOLDOWN
      d.builderHealth.fails.set(tool, { n: cooldown ? 0 : n, skipUntil: cooldown ? now + BUILDER_COOLDOWN_MS : 0 })
      if (cooldown) {
        d.log?.('INGEST', `builder ${tool} failed ${BUILDER_FAILS_BEFORE_COOLDOWN}x in a row — cooling down ${Math.round(BUILDER_COOLDOWN_MS / 60000)}min: ${String(e)}`)
        return false
      }
    }
    d.log?.('INGEST', `builder ${tool} failed (continuing): ${String(e)}`)
    return false
  }
}

export async function runIngestCycle(d: CycleDeps): Promise<CycleReport> {
  const report: CycleReport = {
    decrypted: false, rebuilt: false, indexed: false, transcribed: false,
    batches: 0, recorded: 0, sweptGroups: 0, sweptSuperseded: 0,
    dedupContacts: 0, dedupMerged: 0, settled: 0, settleContacts: 0, newSourceMtime: d.lastSourceMtime,
  }

  // 1. Poke wxvault to force an incremental re-decrypt (it refreshes lazily).
  if (d.hasTool('overview')) {
    try { await d.bridge.call('overview'); report.decrypted = true } catch (e) {
      d.log?.('INGEST', `wxvault poke failed (continuing): ${String(e)}`)
    }
  }

  // 2. Deterministic builders — only when the decrypted source advanced.
  const mtime = d.sourceMaxMtime()
  report.newSourceMtime = mtime
  if (mtime > d.lastSourceMtime) {
    report.rebuilt = await tryBuild(d, 'rebuild')            // wxgraph
    report.indexed = await tryBuild(d, 'index_update')       // wxsearch
    report.transcribed = await tryBuild(d, 'voice_backfill') // wxmedia
  }

  // 3. facts extraction — self-gates via {done:true} when caught up. Prefer
  // the in-process FactsApi (post wxfacts-plugin-retirement); fall back to
  // the MCP bridge, gated on hasTool, when no in-process facts store exists.
  if (d.factsApi) {
    const { batches, recorded, settled } = await runExtraction({
      call: makeInProcFactsCall(d.factsApi), cheapEval: d.cheapEval, cap: d.cap, log: d.log,
    })
    report.batches = batches
    report.recorded = recorded
    report.settled = settled
    // 4. Stock-conflict sweep (temporal-validity backfill) — bounded at
    // SWEEP_GROUPS_PER_CYCLE groups and ≤1 cheapEval per cycle; only on the
    // in-proc facts path (the retired-plugin bridge never grows this).
    const sweep = await runConflictSweep({
      facts: d.factsApi, cheapEval: d.cheapEval, cap: SWEEP_GROUPS_PER_CYCLE, log: d.log,
    })
    report.sweptGroups = sweep.groups
    report.sweptSuperseded = sweep.superseded
    // 5. Obligation dedup (待办 follow-up) — cross-predicate duplicate
    // promises the conflict sweep can't see; ≤DEDUP_CONTACTS_PER_CYCLE cheap
    // calls per cycle.
    const dedup = await runObligationDedup({
      facts: d.factsApi, cheapEval: d.cheapEval, contactCap: DEDUP_CONTACTS_PER_CYCLE, log: d.log,
    })
    report.dedupContacts = dedup.contacts
    report.dedupMerged = dedup.merged
    // 6. Settlement backfill (承诺了结闭环) — stock obligations whose
    // completion was chatted about BEFORE the per-batch step existed sit
    // behind the extraction watermark; replay recent chat through the same
    // judge. ≤SETTLE_CONTACTS_PER_CYCLE cheap calls; dormant chats skipped.
    const settle = await runSettlementBackfill({
      facts: d.factsApi, cheapEval: d.cheapEval, contactCap: SETTLE_CONTACTS_PER_CYCLE, log: d.log,
    })
    report.settleContacts = settle.contacts
    report.settled += settle.settled
  } else if (d.hasTool('extraction_batch')) {
    const { batches, recorded } = await runExtraction({
      call: d.bridge.call, cheapEval: d.cheapEval, cap: d.cap, log: d.log,
    })
    report.batches = batches
    report.recorded = recorded
  }

  return report
}
