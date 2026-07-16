/**
 * social-forwarder.ts — the forward heart (spec #2). Wraps the spine's local
 * answer (judge + pledge) into a "judge + forward": judge locally, then — while
 * the card is within the hop cap and this intent has not been seen before —
 * fan the hop+1 card out to the responder's OWN paired peers (excluding the
 * sender), minting a relay per downstream `yes`, and aggregate their degree-2
 * echoes onto the response. Pure + injected; loop prevention (hop ceiling +
 * never-forward-to-sender + seen-intent dedup) lives here; the network/persist
 * seams are injected. Fail-closed: one bad target never aborts the aggregation.
 */
import type { IntentEvent } from './a2a-server'
import type { IntentCard, MatchReceipt, ForwardedEcho } from './a2a-intent'

export interface ForwarderDeps<T extends { id: string }> {
  /** The existing local answer (makeAnswerIntent + pledge on match:yes). */
  answerLocally(event: IntentEvent): Promise<MatchReceipt>
  /** This responder's paired peers, MINUS the sender. */
  forwardTargets(excludeAgentId: string): T[]
  /** POST the hop+1 card to a peer's /a2a/intent. null on unreachable. */
  forwardSend(target: T, card: IntentCard): Promise<MatchReceipt | null>
  /** Persist a social_relay row for a downstream yes; returns the minted relay_token.
   *  upstreamAgentId = the sender (event.agent.id), so W can later resolve S's identity. */
  recordRelay(intentId: string, upstreamAgentId: string, downstreamAgentId: string): string
  markSeen(intentId: string, expiresAt: string): void
  hasSeen(intentId: string): boolean
  /** Depth cap; forward only while card.hop < hopCap. Default 2. */
  hopCap?: number
}

export function makeForwarder<T extends { id: string }>(deps: ForwarderDeps<T>): (event: IntentEvent) => Promise<MatchReceipt> {
  return async (event) => {
    const card = event.card
    const receipt = await deps.answerLocally(event)   // always judge locally first

    const cap = deps.hopCap ?? 2
    const alreadySeen = deps.hasSeen(card.intent_id)
    if (!alreadySeen) {
      // Loop prevention: record BEFORE forwarding so a diamond re-arrival dedups.
      // A persistence hiccup must not abort a network action we may still take.
      try { deps.markSeen(card.intent_id, card.expires_at) } catch { /* logged by dep impl */ }
    }
    // Skip forwarding when: already seen (dedup), or at/over the hop ceiling.
    if (alreadySeen || card.hop >= cap) return receipt

    const forwarded: ForwardedEcho[] = []
    for (const target of deps.forwardTargets(event.agent.id)) {
      try {
        const fwdCard: IntentCard = { ...card, hop: card.hop + 1 }
        const r = await deps.forwardSend(target, fwdCard)
        if (r && r.match === 'yes') {
          const relayToken = deps.recordRelay(card.intent_id, event.agent.id, target.id)
          forwarded.push({ blurb: r.blurb ?? '', degree: card.hop + 1, relay_token: relayToken })
        }
      } catch {
        // One bad/unreachable target (or a relay-write that threw) must never
        // abort the rest of the aggregation. Fail closed — skip and continue.
        continue
      }
    }
    return forwarded.length > 0 ? { ...receipt, forwarded } : receipt
  }
}
