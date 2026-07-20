/**
 * forward-budget.ts — a per-sender token bucket bounding how many DISTINCT
 * intents an upstream sender may cause this daemon (as intermediary W) to
 * forward on their behalf, in a given time window (sub-project C). Mirrors
 * relay/rate-limit.ts's token-bucket SHAPE (per-key Map, `Math.max(0, refill)`,
 * cap-to-capacity) but is an INDEPENDENT daemon-core copy — it does not
 * import from relay/ (relay/ is a separate standalone process; see spec §3.1
 * "形态复刻...但住在 daemon core"). Unlike relay's `allow(key, now)`, the
 * consume signature carries no `now` argument: the clock is injected ONCE at
 * construction via `opts.now`, defaulting to `Date.now` — production call
 * sites never thread a clock through, while tests still drive it
 * deterministically (same idiom as src/daemon/activity/store.ts).
 * See docs/superpowers/specs/2026-07-20-forward-budget-C-design.md §3.1.
 */
export interface ForwardBudget {
  /** true + consumes one token if the sender has budget left this window;
   *  false (no consume) if the bucket is empty. */
  withinBudget(senderId: string): boolean
}

export function makeForwardBudget(opts: { perSender: number; windowMs: number; now?: () => number }): ForwardBudget {
  const now = opts.now ?? Date.now
  const buckets = new Map<string, { tokens: number; ts: number }>()
  return {
    withinBudget(senderId) {
      const t = now()
      const b = buckets.get(senderId) ?? { tokens: opts.perSender, ts: t }
      const refill = ((t - b.ts) / opts.windowMs) * opts.perSender
      const tokens = Math.min(opts.perSender, b.tokens + Math.max(0, refill))
      if (tokens < 1) { buckets.set(senderId, { tokens, ts: t }); return false }
      buckets.set(senderId, { tokens: tokens - 1, ts: t })
      return true
    },
  }
}
