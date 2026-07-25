/**
 * forward-budget-seam.ts — the wiring-level construction of sub-project C's
 * per-sender forward budget. Builds exactly ONE makeForwardBudget instance
 * (sized from the operator's config, or the 30/hour default) and wraps its
 * withinBudget in the required local-only log line (spec §3.4) — the
 * returned closure is injected UNCHANGED into BOTH consume points
 * (ForwarderDeps.withinBudget + LetterRelayDeps.withinBudget in wire-social.ts)
 * so a sender's seek-forwards and letter-forwards draw from the SAME bucket.
 * Kept as its own tiny seam (same pattern as postletter-route.ts /
 * mailbox-dispatch-seam.ts) so the sharing property is unit-testable without
 * invoking the whole (untested-as-a-unit) wireSocial().
 */
import { makeForwardBudget } from '../../core/forward-budget'
import { resolveForwardBudget, type AgentConfig } from '../../lib/agent-config'

export function buildSharedForwardBudget(
  config: AgentConfig,
  log: (tag: string, line: string, fields?: Record<string, unknown>) => void,
  deps?: { now?: () => number },
): (senderId: string) => boolean {
  const { per_sender, window_ms } = resolveForwardBudget(config)
  const budget = makeForwardBudget({ perSender: per_sender, windowMs: window_ms, now: deps?.now })
  return (senderId) => {
    const ok = budget.withinBudget(senderId)
    if (!ok) log('SOCIAL_REC', `[forward-budget] over budget for ${senderId}, local-only`)
    return ok
  }
}
