/**
 * Obligation-dedup sweep (2026-08-24, 待办 follow-up) — the same promise
 * routinely lands in facts.db several times under DIFFERENT predicates
 * ("promise_to_setup_tailscale" vs "帮对方重建/配置VPS与远程连接"), which the
 * record-time conflict judge never sees (it groups by predicate). Each
 * ingest cycle this sweep takes the contacts carrying the most active
 * obligations and asks one judge call per contact: which entries restate
 * the same commitment? Approved pairs go through FactsApi.mergeObligations'
 * deterministic guard (same contact, both active obligations).
 *
 * Convergence: merged losers leave the active set, so a contact drops out
 * of the heavy feed once clean; a [] verdict now records a judge_state
 * fingerprint (2026-08-28) so the contact is skipped for free until its
 * obligation stock actually changes — before that, the same top contacts
 * were re-judged every 25-minute cycle forever while the rest of the heavy
 * feed starved behind the cap. The feed is overscanned so skipped contacts
 * make room for that backlog.
 */
import type { FactsApi } from '../../../core/knowledge/facts'
import type { FactRow } from '../../../core/knowledge/store'
import { parseSupersedePairs } from './extract'
import { SWEEP_FEED_OVERSCAN } from './sweep-conflicts'

/** Content fingerprint of one contact's active obligations — judged again
 *  only when the set (id, predicate, value, time_ref) changes. */
export function obligationFingerprint(rows: Array<Pick<FactRow, 'id' | 'predicate' | 'value' | 'time_ref'>>): string {
  return rows.map((r) => `${r.id}=${r.predicate}=${r.value}=${r.time_ref ?? ''}`).sort().join('|')
}

export interface ObligationDedupDeps {
  facts: FactsApi
  cheapEval: (prompt: string) => Promise<string>
  /** Max contacts judged per cycle (one cheapEval each). */
  contactCap: number
  log?: (tag: string, msg: string) => void
}

/** One contact's active obligations → a duplicate-merge judge prompt. */
export function buildObligationDedupPrompt(contact: string, rows: FactRow[]): string {
  const lines = rows.map(r =>
    `- #${r.id}「${r.predicate}」${r.value}${r.time_ref ? `（${r.time_ref}）` : ''}`,
  ).join('\n')
  return (
    `你是一个事实库管理器（不是聊天助手）。下面是与同一位联系人之间尚未了结的承诺清单，` +
    `其中可能有同一件事的重复表述。\n` +
    `找出重复：每组重复里保留**信息最全**的一条，其余作为重复输出 ` +
    `{"supersede": 重复条目id, "by": 保留条目id}。\n` +
    `只合并确定是同一件事的；不同的事哪怕相似也不要合并。不确定就不输出。\n` +
    `**只输出 JSON 数组，不要任何解释，不要代码围栏。**没有重复就输出 []。\n\n` +
    lines
  )
}

export interface ObligationDedupReport {
  contacts: number
  merged: number
}

export async function runObligationDedup(d: ObligationDedupDeps): Promise<ObligationDedupReport> {
  let heavy: Array<{ contact: string; n: number }>
  try {
    heavy = d.facts.obligationHeavyContacts(d.contactCap * SWEEP_FEED_OVERSCAN)
  } catch (e) {
    d.log?.('INGEST', `obligation dedup feed failed: ${String(e)}`)
    return { contacts: 0, merged: 0 }
  }
  let merged = 0
  let judged = 0
  for (const h of heavy) {
    if (judged >= d.contactCap) break
    const byKind = (d.facts.contactFacts(h.contact) as { by_kind?: Record<string, FactRow[]> }).by_kind ?? {}
    const rows = byKind['obligation'] ?? []
    if (rows.length < 2) continue
    const key = `obdupe:${h.contact}`
    const fingerprint = obligationFingerprint(rows)
    if (d.facts.judgeFingerprint(key) === fingerprint) continue   // unchanged stock — skip for free
    judged++
    try {
      const pairs = parseSupersedePairs(await d.cheapEval(buildObligationDedupPrompt(h.contact, rows)))
      if (pairs.length > 0) {
        const res = d.facts.mergeObligations(pairs, Math.floor(Date.now() / 1000)) as { merged?: number }
        merged += res.merged ?? 0
      }
      // Verdict recorded (even []): pre-judge fingerprint marks the stock as
      // judged; a merge changes the rows so the contact re-opens naturally.
      d.facts.setJudgeFingerprint(key, fingerprint, Math.floor(Date.now() / 1000))
    } catch (e) {
      // Same non-fatal posture as every other judge: no fingerprint recorded,
      // the contact stays in the feed, the next cycle retries.
      d.log?.('INGEST', `obligation dedup judge failed for ${h.contact} (retry next cycle): ${String(e)}`)
    }
  }
  return { contacts: judged, merged }
}
