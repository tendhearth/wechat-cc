/**
 * rate-limit.ts — a per-key token bucket. The relay keys drops by source-IP
 * AND by recipient mailbox; an empty bucket → the drop is refused (429). In
 * memory only (v0 single relay). See spec §3.1 (限流).
 */
export interface RateLimiter { allow(key: string, now: number): boolean }

export function makeRateLimiter(opts: { capacity: number; refillPerSec: number }): RateLimiter {
  const buckets = new Map<string, { tokens: number; ts: number }>()
  return {
    allow(key, now) {
      const b = buckets.get(key) ?? { tokens: opts.capacity, ts: now }
      const refill = ((now - b.ts) / 1000) * opts.refillPerSec
      const tokens = Math.min(opts.capacity, b.tokens + Math.max(0, refill))
      if (tokens < 1) { buckets.set(key, { tokens, ts: now }); return false }
      buckets.set(key, { tokens: tokens - 1, ts: now })
      return true
    },
  }
}
