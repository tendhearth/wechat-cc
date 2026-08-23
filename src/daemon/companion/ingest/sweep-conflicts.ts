/**
 * Stock-conflict sweep — the temporal-validity backfill. record-time conflict
 * detection (extract.ts) only sees NEW facts; contradictions recorded before
 * it existed (or whose judge call failed) sit in facts.db forever. Each
 * ingest cycle this sweep pulls up to `cap` conflicted groups (active,
 * same contact+predicate, ≥2 distinct values), asks ONE judge call across
 * all of them (update-vs-coexist, conservative by instruction), and applies
 * approved pairs through FactsApi.supersede's deterministic guard.
 *
 * Idempotent by construction: a superseded group drops below 2 active
 * values and leaves the feed; a coexist verdict leaves the group in the
 * feed but re-judging it is harmless (the judge keeps saying coexist).
 * Cost is bounded: ≤1 cheapEval per cycle regardless of cap.
 */
import type { FactsApi } from '../../../core/knowledge/facts'
import { buildConflictPrompt, parseSupersedePairs, type ConflictGroup } from './extract'

export interface SweepDeps {
  facts: FactsApi
  cheapEval: (prompt: string) => Promise<string>
  /** Max conflicted groups judged per cycle. */
  cap: number
  log?: (tag: string, msg: string) => void
}

export interface SweepReport {
  groups: number
  superseded: number
}

export async function runConflictSweep(d: SweepDeps): Promise<SweepReport> {
  let groups: ReturnType<FactsApi['conflictedGroups']>
  try {
    groups = d.facts.conflictedGroups(d.cap)
  } catch (e) {
    d.log?.('INGEST', `conflict sweep feed failed: ${String(e)}`)
    return { groups: 0, superseded: 0 }
  }
  if (groups.length === 0) return { groups: 0, superseded: 0 }

  // Newest fact plays the "new value" role record-time detection would have
  // given it; every older active value is the against-set.
  const conflictGroups: ConflictGroup[] = groups
    .filter((g) => g.facts.length >= 2)
    .map((g) => ({
      id: g.facts[0]!.id,
      predicate: g.predicate,
      value: g.facts[0]!.value,
      against: g.facts.slice(1).map((f) => ({ id: f.id, value: f.value })),
    }))
  if (conflictGroups.length === 0) return { groups: 0, superseded: 0 }

  let superseded = 0
  try {
    const pairs = parseSupersedePairs(await d.cheapEval(buildConflictPrompt(conflictGroups)))
    if (pairs.length > 0) {
      const res = d.facts.supersede(pairs, Math.floor(Date.now() / 1000)) as { superseded?: number }
      superseded = res.superseded ?? 0
    }
  } catch (e) {
    // Judge/model failure is non-fatal: the groups stay in the feed and the
    // next cycle retries — same posture as record-time resolution.
    d.log?.('INGEST', `conflict sweep judge failed (retry next cycle): ${String(e)}`)
  }
  return { groups: conflictGroups.length, superseded }
}
