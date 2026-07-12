import type { CheapEval } from './agent-provider'
import type { A2AAgentRecord } from '../lib/agent-config'
import { newIntentId, type IntentCard, type MatchReceipt } from './a2a-intent'
import { gateOutbound } from './a2a-disclosure'

export interface BrokerDeps {
  discover: (topic: string) => Promise<A2AAgentRecord[]>
  send: (hand: A2AAgentRecord, card: IntentCard) => Promise<MatchReceipt | null>
  confirmWithOwner: (summary: string) => Promise<boolean>
  confirmPeer: (hand: A2AAgentRecord, card: IntentCard) => Promise<boolean>
  policy: string
  cheapEval: CheapEval
  ttlMs?: number
}
export interface SeekOutcome { intent_id: string; matched: Array<{ hand: string; blurb?: string }>; lit: string[] }

/**
 * Sanitize a peer-controlled blurb before it lands in the `confirmWithOwner`
 * summary shown to the operator. The blurb already passed through the
 * PEER's own `gateOutbound` (social-answer.ts), but that's the peer's CC,
 * not ours — a hostile or buggy peer could still stuff newlines/control
 * characters or an oversized payload into what becomes a WeChat message on
 * this side. Defence-in-depth, not a trust signal: collapse whitespace and
 * cap length.
 */
function sanitizeBlurb(blurb: string): string {
  return blurb.replace(/\s+/g, ' ').trim().slice(0, 120)
}

export function makeBroker(deps: BrokerDeps) {
  return {
    async seek(topic: string, opts?: { city?: string }): Promise<SeekOutcome> {
      const intent_id = newIntentId()
      // Gate the OUTBOUND intent topic before it ever leaves.
      const gated = await gateOutbound(topic, { policy: deps.policy, cheapEval: deps.cheapEval })
      if (!gated.ok) return { intent_id, matched: [], lit: [] }
      const ttl = deps.ttlMs ?? 10 * 60_000
      // Gate the city field if present; omit from card if blocked (safe degradation).
      let cardCity: string | undefined
      if (opts?.city) {
        const gatedCity = await gateOutbound(opts.city, { policy: deps.policy, cheapEval: deps.cheapEval })
        if (gatedCity.ok) {
          cardCity = gatedCity.redacted
        }
        // If gatedCity.ok is false, cardCity remains undefined and city is omitted from card
      }
      const card: IntentCard = { intent_id, kind: 'seek', topic: gated.redacted, ...(cardCity ? { city: cardCity } : {}), expires_at: new Date(Date.now() + ttl).toISOString() }

      let candidates: A2AAgentRecord[]
      try {
        candidates = await deps.discover(gated.redacted)
      } catch {
        // Discovery failure is fail-closed — no candidates, no exposure.
        candidates = []
      }

      const matched: Array<{ hand: A2AAgentRecord; blurb?: string }> = []
      for (const hand of candidates) {
        try {
          const r = await deps.send(hand, card)
          if (r && r.match === 'yes') matched.push({ hand, blurb: r.blurb })
        } catch {
          // One bad/unreachable peer must not abort the whole seek —
          // skip it and keep going with the rest of the candidates.
          continue
        }
      }

      const lit: string[] = []
      for (const m of matched) {
        try {
          const safeBlurb = m.blurb ? sanitizeBlurb(m.blurb) : undefined
          const mine = await deps.confirmWithOwner(`${m.hand.name}${safeBlurb ? ' ' + safeBlurb : ''},牵个线?`)
          const theirs = mine ? await deps.confirmPeer(m.hand, card) : false
          if (mine && theirs) lit.push(m.hand.id)
        } catch {
          // A confirm-phase failure for one peer must not affect the
          // others. Fail closed — not lit — rather than reject the seek.
          continue
        }
      }
      return { intent_id, matched: matched.map(m => ({ hand: m.hand.id, blurb: m.blurb })), lit }
    },
  }
}
