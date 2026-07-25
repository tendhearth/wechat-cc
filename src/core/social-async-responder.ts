/**
 * social-async-responder.ts — the v2 receiver (spec §3/§4): fast-ack every
 * /a2a/intent, then judge + echo + forward in the background. Replaces
 * social-forwarder.ts's judge-inline + sync forwarded[] aggregation. Loop
 * prevention is unchanged (hop cap + never-forward-to-sender + seen-intent
 * dedup); markSeen now ALSO records the origin so the echo return leg
 * (social-echo-relay / onEcho) can route a downstream echo onward, even
 * after a restart. All background failures are fail-closed: no echo.
 */
import type { IntentEvent } from './a2a-server'
import type { IntentCard, MatchReceipt } from './a2a-intent'

export interface AsyncResponderDeps<T extends { id: string }> {
  answerLocally(event: IntentEvent): Promise<MatchReceipt>
  postEcho(toAgentId: string, msg: { intent_id: string; echo: { blurb: string; degree: number } }): Promise<boolean>
  forwardTargets(excludeAgentId: string): T[]
  forwardSend(target: T, card: IntentCard): Promise<boolean>
  markSeen(intentId: string, expiresAt: string, originAgentId: string): void
  hasSeen(intentId: string): boolean
  withinBudget?(senderId: string): boolean
  hopCap?: number
  schedule?(fn: () => Promise<void>): void
  log?(tag: string, line: string): void
}

export function makeAsyncResponder<T extends { id: string }>(deps: AsyncResponderDeps<T>): (event: IntentEvent) => Promise<MatchReceipt> {
  const schedule = deps.schedule ?? ((fn: () => Promise<void>) => { void fn().catch(() => {}) })
  const log = deps.log ?? (() => {})
  return async (event) => {
    const card = event.card
    const senderId = event.agent.id
    const alreadySeen = deps.hasSeen(card.intent_id)
    if (!alreadySeen) {
      // Record BEFORE ack/forward so a diamond re-arrival dedups; origin is
      // what the echo return leg routes by. A persistence hiccup must not
      // abort the ack.
      try { deps.markSeen(card.intent_id, card.expires_at, senderId) } catch { /* logged by dep impl */ }
    }
    schedule(async () => {
      // ① own judge → async echo back to the SENDER (registry-verified id).
      try {
        const receipt = await deps.answerLocally(event)
        if (receipt.match === 'yes') {
          const ok = await deps.postEcho(senderId, { intent_id: card.intent_id, echo: { blurb: receipt.blurb ?? '', degree: card.hop } })
          if (!ok) log('SOCIAL_REC', `echo post dropped intent=${card.intent_id} to=${senderId}`)
        }
      } catch (err) { log('SOCIAL_REC', `answer/echo failed intent=${card.intent_id}: ${err instanceof Error ? err.message : String(err)}`) }
      // ② forward fan-out (unchanged gates; sends are fire-and-forget bools —
      // downstream echoes come back via /a2a/echo and the relay leg).
      const cap = deps.hopCap ?? 2
      const withinBudget = deps.withinBudget ?? (() => true)
      if (alreadySeen || card.hop >= cap || !withinBudget(senderId)) return
      for (const target of deps.forwardTargets(senderId)) {
        try { await deps.forwardSend(target, { ...card, hop: card.hop + 1 }) }
        catch { continue }   // one bad target never aborts the rest
      }
    })
    return { intent_id: card.intent_id, match: 'no', async: true }
  }
}
