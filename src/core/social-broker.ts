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

export function makeBroker(deps: BrokerDeps) {
  return {
    async seek(topic: string, opts?: { city?: string }): Promise<SeekOutcome> {
      const intent_id = newIntentId()
      // Gate the OUTBOUND intent topic before it ever leaves.
      const gated = await gateOutbound(topic, { policy: deps.policy, peerNames: [], cheapEval: deps.cheapEval })
      if (!gated.ok) return { intent_id, matched: [], lit: [] }
      const ttl = deps.ttlMs ?? 10 * 60_000
      const card: IntentCard = { intent_id, kind: 'seek', topic: gated.redacted, ...(opts?.city ? { city: opts.city } : {}), expires_at: new Date(Date.now() + ttl).toISOString() }
      const candidates = await deps.discover(gated.redacted)
      const matched: Array<{ hand: A2AAgentRecord; blurb?: string }> = []
      for (const hand of candidates) {
        const r = await deps.send(hand, card)
        if (r && r.match === 'yes') matched.push({ hand, blurb: r.blurb })
      }
      const lit: string[] = []
      for (const m of matched) {
        const mine = await deps.confirmWithOwner(`${m.hand.name}${m.blurb ? ' ' + m.blurb : ''},牵个线?`)
        const theirs = mine ? await deps.confirmPeer(m.hand, card) : false
        if (mine && theirs) lit.push(m.hand.id)
      }
      return { intent_id, matched: matched.map(m => ({ hand: m.hand.id, blurb: m.blurb })), lit }
    },
  }
}
