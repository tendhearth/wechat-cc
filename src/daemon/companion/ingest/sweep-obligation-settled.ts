/**
 * Obligation-settlement backfill (2026-08-24, 承诺了结闭环 follow-up) —
 * extract.ts's per-batch settlement only sees NEW messages; every promise
 * whose completion was discussed before the feature shipped sits behind the
 * extraction watermark forever. This sweep takes the contacts still carrying
 * active obligations (minCount=1 — a lone promise settles too), replays
 * their recent chat window through the same settlement judge, and applies
 * confirmed ids through FactsApi.settleObligations' deterministic guard.
 *
 * Cost damper: contacts with no message inside SETTLE_ACTIVITY_WINDOW_S are
 * skipped without a judge call — a dormant chat can't have new evidence, so
 * the sweep converges to zero calls once the stock is either settled or
 * stale. Same conservative posture as the dedup/conflict sweeps.
 */
import type { FactsApi } from '../../../core/knowledge/facts'
import type { FactRow } from '../../../core/knowledge/store'
import { buildSettlementPrompt, parseResolvedIds } from './extract'

/** Only judge contacts with chat activity in the last 30 days. */
export const SETTLE_ACTIVITY_WINDOW_S = 30 * 24 * 3600

/** Recent-chat window fed to the judge per contact. */
const RECENT_MESSAGES = 80

export interface SettlementBackfillDeps {
  facts: FactsApi
  cheapEval: (prompt: string) => Promise<string>
  /** Max contacts judged per cycle (one cheapEval each). */
  contactCap: number
  now?: () => number
  log?: (tag: string, msg: string) => void
}

export async function runSettlementBackfill(d: SettlementBackfillDeps): Promise<{ contacts: number; settled: number }> {
  const now = d.now ?? (() => Math.floor(Date.now() / 1000))
  let heavy: Array<{ contact: string; n: number }>
  try {
    heavy = d.facts.obligationHeavyContacts(d.contactCap, 1)
  } catch (e) {
    d.log?.('INGEST', `settlement backfill feed failed: ${String(e)}`)
    return { contacts: 0, settled: 0 }
  }
  let judged = 0
  let settled = 0
  for (const h of heavy) {
    try {
      const byKind = (d.facts.contactFacts(h.contact) as { by_kind?: Record<string, FactRow[]> }).by_kind ?? {}
      const rows = byKind['obligation'] ?? []
      if (rows.length === 0) continue
      const recent = d.facts.recentMessages(h.contact, RECENT_MESSAGES)
      const newest = recent[recent.length - 1]?.time ?? 0
      if (newest < now() - SETTLE_ACTIVITY_WINDOW_S) continue   // dormant chat — no new evidence
      judged++
      const ids = parseResolvedIds(await d.cheapEval(buildSettlementPrompt(
        { batch_id: 'backfill', contact: h.contact,
          messages: recent.map(m => ({ msg_key: '', sender: m.sender, time: m.time, text: m.text })) },
        rows,
      )))
      if (ids.length > 0) {
        const res = d.facts.settleObligations(h.contact, ids, now()) as { settled?: number }
        settled += res.settled ?? 0
      }
    } catch (e) {
      // Non-fatal like every other judge: nothing changed, retry next cycle.
      d.log?.('INGEST', `settlement backfill failed for ${h.contact} (retry next cycle): ${String(e)}`)
    }
  }
  return { contacts: judged, settled }
}
