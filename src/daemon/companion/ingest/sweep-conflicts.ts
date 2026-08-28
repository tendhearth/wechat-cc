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
 *
 * Convergence (2026-08-28): "harmless" re-judging was a permanent burn —
 * a coexist verdict left the group in the feed with its updated_at
 * untouched, so the SAME top-cap groups were re-judged every 25-minute
 * cycle forever while the backlog behind them starved. Each judged group
 * now records a content fingerprint (judge_state in facts.db); unchanged
 * stock is skipped without a call, and the feed is overscanned so skipped
 * groups make room for the backlog. New evidence changes the fingerprint
 * and re-opens the group naturally.
 */
import type { FactsApi } from '../../../core/knowledge/facts'
import type { FactRow } from '../../../core/knowledge/store'
import { buildConflictPrompt, parseSupersedePairs, type ConflictGroup } from './extract'

/** Feed rows fetched per cycle relative to cap — fingerprint-skipped stock
 *  must not starve the backlog sitting behind it in the stable feed order. */
export const SWEEP_FEED_OVERSCAN = 40

/** Content fingerprint of one conflicted group: judged again only when the
 *  set of active (id, value) pairs changes. Order-insensitive. */
export function conflictGroupFingerprint(facts: Array<Pick<FactRow, 'id' | 'value'>>): string {
  return facts.map((f) => `${f.id}=${f.value}`).sort().join('|')
}

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
    groups = d.facts.conflictedGroups(d.cap * SWEEP_FEED_OVERSCAN)
  } catch (e) {
    d.log?.('INGEST', `conflict sweep feed failed: ${String(e)}`)
    return { groups: 0, superseded: 0 }
  }
  if (groups.length === 0) return { groups: 0, superseded: 0 }

  // Drop groups whose stock is unchanged since their last verdict, then cap.
  const fresh: Array<{ group: (typeof groups)[number]; key: string; fingerprint: string }> = []
  for (const g of groups) {
    if (g.facts.length < 2) continue
    const key = `conflict:${g.contact}:${g.predicate}`
    const fingerprint = conflictGroupFingerprint(g.facts)
    if (d.facts.judgeFingerprint(key) === fingerprint) continue   // same stock, same verdict — skip
    fresh.push({ group: g, key, fingerprint })
    if (fresh.length >= d.cap) break
  }
  if (fresh.length === 0) return { groups: 0, superseded: 0 }

  // Newest fact plays the "new value" role record-time detection would have
  // given it; every older active value is the against-set.
  const conflictGroups: ConflictGroup[] = fresh.map(({ group: g }) => ({
    id: g.facts[0]!.id,
    predicate: g.predicate,
    value: g.facts[0]!.value,
    against: g.facts.slice(1).map((f) => ({ id: f.id, value: f.value })),
  }))

  let superseded = 0
  try {
    const pairs = parseSupersedePairs(await d.cheapEval(buildConflictPrompt(conflictGroups)))
    if (pairs.length > 0) {
      const res = d.facts.supersede(pairs, Math.floor(Date.now() / 1000)) as { superseded?: number }
      superseded = res.superseded ?? 0
    }
    // Verdict recorded (even coexist/[]): the pre-judge fingerprint marks this
    // stock as judged. A superseded group's content changed, so its stored
    // fingerprint no longer matches and it gets one confirming re-check.
    const now = Math.floor(Date.now() / 1000)
    for (const { key, fingerprint } of fresh) d.facts.setJudgeFingerprint(key, fingerprint, now)
  } catch (e) {
    // Judge/model failure is non-fatal: no fingerprints recorded, the groups
    // stay in the feed and the next cycle retries — same posture as
    // record-time resolution.
    d.log?.('INGEST', `conflict sweep judge failed (retry next cycle): ${String(e)}`)
  }
  return { groups: conflictGroups.length, superseded }
}
