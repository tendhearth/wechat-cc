/**
 * social-relay-reveal.ts — the INTERMEDIARY's (介绍人 / W) reveal reconciliation
 * for a 2-hop connection (spec #2). Both endpoints reveal TO W (S carries the
 * relay_token; Q reveals its pledge keyed intent:W). W pivots the two legs on
 * the durable social_relay row: it marks whichever leg came in and, when both
 * are revealed, crosses the two endpoints' identities — resolved from W's OWN
 * registry, so identity never travels across a hop. The second revealer learns
 * mutual synchronously; the first is completed by a post-back. Row-driven →
 * survives a W restart.
 */
import type { RelayStore } from './social-relay-store'
import type { PeerIdentity } from './social-reveal'

export interface RelayReconcilerDeps {
  relayStore: RelayStore
  /** Resolve a direct peer's identity from W's registry (both endpoints are W's peers). */
  identityOf(agentId: string): PeerIdentity | null
  /** Complete the upstream (S) leg by posting back to S with the relay_token + Q's identity. */
  completeUpstream(upstreamAgentId: string, intentId: string, relayToken: string, downstreamIdentity: PeerIdentity): void
  /** Complete the downstream (Q) leg by posting back to Q (pledge keyed intent:W) with S's identity. */
  completeDownstream(downstreamAgentId: string, intentId: string, upstreamIdentity: PeerIdentity): void
  /** Pre-mutual nudge to the un-revealed endpoint (relayToken only when nudging S). */
  nudge(agentId: string, intentId: string, relayToken?: string): void
  /** 介绍人 warmth: tell W's own owner it connected upstream↔downstream. */
  notify3way(intentId: string, upstream: PeerIdentity, downstream: PeerIdentity): void
}

export interface RelayReconciler {
  onRelayReveal(ev: { callerAgentId: string; intentId: string; relayToken?: string }): { mutual: boolean; identity?: PeerIdentity } | null
}

export function makeRelayReconciler(deps: RelayReconcilerDeps): RelayReconciler {
  return {
    onRelayReveal({ callerAgentId, intentId, relayToken }) {
      // Token ⇒ the caller is S (upstream). No token ⇒ the caller is Q (downstream),
      // resolved by (intent_id, downstream=caller).
      const isUpstreamLeg = !!relayToken
      const relay = isUpstreamLeg
        ? deps.relayStore.get(`${intentId}:${relayToken}`)
        : deps.relayStore.getByIntentDownstream(intentId, callerAgentId)
      if (!relay) return null   // not a relay we hold — caller falls through to its own revealer

      const sIdentity = deps.identityOf(relay.upstream_agent_id)
      const qIdentity = deps.identityOf(relay.downstream_agent_id)
      const otherForCaller = isUpstreamLeg ? qIdentity : sIdentity

      // Idempotency: if THIS leg was already revealed, this is a retry — no writes,
      // no nudge/complete/notify; return a consistent answer (spine invariant).
      const legAlready = isUpstreamLeg ? !!relay.upstream_revealed_at : !!relay.downstream_revealed_at
      if (legAlready) {
        const both = !!relay.upstream_revealed_at && !!relay.downstream_revealed_at
        return both ? { mutual: true, ...(otherForCaller ? { identity: otherForCaller } : {}) } : { mutual: false }
      }

      const now = new Date().toISOString()
      const otherLegRevealed = isUpstreamLeg ? !!relay.downstream_revealed_at : !!relay.upstream_revealed_at

      if (otherLegRevealed) {
        // Crossing path: both identities must resolve from W's registry BEFORE
        // this leg is marked. A transient registry miss must NOT strand the
        // first revealer — leave the leg unmarked (no writes, no nudge/complete/
        // notify) so a later retry (once the registry heals) re-enters here and
        // completes the cross instead of falling into the legAlready branch.
        if (!sIdentity || !qIdentity) return { mutual: false }

        // Both legs in → mutual. Cross identities: post back to whoever revealed
        // FIRST (the OTHER leg); the caller (second) learns mutual synchronously.
        if (isUpstreamLeg) deps.relayStore.setUpstreamRevealed(relay.id, now)
        else deps.relayStore.setDownstreamRevealed(relay.id, now)

        const other = isUpstreamLeg ? qIdentity : sIdentity
        if (isUpstreamLeg) deps.completeDownstream(relay.downstream_agent_id, intentId, sIdentity)
        else deps.completeUpstream(relay.upstream_agent_id, intentId, relay.relay_token, qIdentity)
        deps.notify3way(intentId, sIdentity, qIdentity)
        return { mutual: true, identity: other }
      }

      // Only this leg revealed → mark it, then nudge the un-revealed endpoint so
      // its owner gets beat #2. Nudging S must carry the relay_token; nudging Q
      // must not. No identity is needed on this path.
      if (isUpstreamLeg) deps.relayStore.setUpstreamRevealed(relay.id, now)
      else deps.relayStore.setDownstreamRevealed(relay.id, now)

      if (isUpstreamLeg) deps.nudge(relay.downstream_agent_id, intentId)
      else deps.nudge(relay.upstream_agent_id, intentId, relay.relay_token)
      return { mutual: false }
    },
  }
}
