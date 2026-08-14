/**
 * social-relay-reveal.ts — the INTERMEDIARY's (介绍人 / W) reveal reconciliation
 * for a 2-hop connection (spec #2). Both endpoints reveal TO W (S carries the
 * relay_token; Q reveals its pledge keyed intent:W). W pivots the two legs on
 * the durable social_relay row: it marks whichever leg came in and, when both
 * are revealed, crosses the two endpoints' per-connection pubkey HANDLES
 * (PenpalHandle) — never a real identity. Pubkeys are ephemeral + endpoint-
 * generated, so W cannot resolve them from a registry: it PERSISTS each leg's
 * presented handle when that leg reveals, and hands the OTHER leg's STORED
 * handle to whoever reveals second. The second revealer learns mutual
 * synchronously; the first is completed by a post-back. Row-driven → survives
 * a W restart. W stays content-blind: it never learns either endpoint's real
 * identity, only the ephemeral handles it crosses.
 */
import type { RelayStore } from './social-relay-store'
import type { PenpalHandle } from './penpal-crypto'

export interface RelayReconcilerDeps {
  relayStore: RelayStore
  /** Complete the upstream (S) leg by posting back to S with the relay_token + Q's handle. */
  completeUpstream(upstreamAgentId: string, intentId: string, relayToken: string, downstreamHandle: PenpalHandle): void
  /** Complete the downstream (Q) leg by posting back to Q (pledge keyed intent:W) with S's handle. */
  completeDownstream(downstreamAgentId: string, intentId: string, upstreamHandle: PenpalHandle): void
  /** Pre-mutual nudge to the un-revealed endpoint (relayToken only when nudging S). */
  nudge(agentId: string, intentId: string, relayToken?: string): void
  /** 介绍人 warmth: tell W's own owner it connected a pair — content-free, NO real names (W never had them). */
  notify3way(intentId: string, upstream: PenpalHandle, downstream: PenpalHandle): void
}

export interface RelayReconciler {
  onRelayReveal(ev: { callerAgentId: string; intentId: string; relayToken?: string; peerHandle?: PenpalHandle }): { mutual: boolean; handle?: PenpalHandle } | null
}

export function makeRelayReconciler(deps: RelayReconcilerDeps): RelayReconciler {
  return {
    onRelayReveal({ callerAgentId, intentId, relayToken, peerHandle }) {
      // Token ⇒ the caller is S (upstream). No token ⇒ the caller is Q (downstream),
      // resolved by (intent_id, downstream=caller).
      const isUpstreamLeg = !!relayToken
      const relay = isUpstreamLeg
        ? deps.relayStore.get(`${intentId}:${relayToken}`)
        : deps.relayStore.getByIntentDownstream(intentId, callerAgentId)
      if (!relay) return null   // not a relay we hold — caller falls through to its own revealer

      // Caller-binding (defense-in-depth): a relay_token addresses a specific
      // upstream leg. If the presenting caller isn't the row's own upstream,
      // this isn't a relay we hold FOR THIS CALLER — treat as no relay (null),
      // same as the downstream branch's caller-bound lookup already does.
      if (isUpstreamLeg && relay.upstream_agent_id !== callerAgentId) return null

      const storedUpstreamHandle: PenpalHandle | null = relay.upstream_handle ? JSON.parse(relay.upstream_handle) : null
      const storedDownstreamHandle: PenpalHandle | null = relay.downstream_handle ? JSON.parse(relay.downstream_handle) : null
      const otherForCaller = isUpstreamLeg ? storedDownstreamHandle : storedUpstreamHandle

      // Idempotency: if THIS leg was already revealed, this is a retry — no writes,
      // no nudge/complete/notify; return a consistent answer (spine invariant).
      const legAlready = isUpstreamLeg ? !!relay.upstream_revealed_at : !!relay.downstream_revealed_at
      if (legAlready) {
        const both = !!relay.upstream_revealed_at && !!relay.downstream_revealed_at
        return both ? { mutual: true, ...(otherForCaller ? { handle: otherForCaller } : {}) } : { mutual: false }
      }

      const now = new Date().toISOString()
      const otherLegRevealed = isUpstreamLeg ? !!relay.downstream_revealed_at : !!relay.upstream_revealed_at

      if (otherLegRevealed) {
        // Crossing path: the OTHER leg's handle must already be STORED before
        // this leg is marked. A transient missing store (shouldn't happen —
        // the other leg's reveal should have persisted it) must NOT strand the
        // first revealer — leave the leg unmarked (no writes, no nudge/complete/
        // notify) so a later retry (once healed) re-enters here and completes
        // the cross instead of falling into the legAlready branch.
        const storedOtherHandle = isUpstreamLeg ? storedDownstreamHandle : storedUpstreamHandle
        if (!storedOtherHandle) return { mutual: false }

        // Both legs in → mutual. Persist the caller's OWN handle on its leg,
        // mark it revealed, then cross: post back to whoever revealed FIRST
        // (the OTHER leg) with the caller's handle; the caller (second) learns
        // mutual (with the other leg's STORED handle) synchronously.
        if (isUpstreamLeg) {
          if (peerHandle) deps.relayStore.setUpstreamHandle(relay.id, peerHandle)
          deps.relayStore.setUpstreamRevealed(relay.id, now)
        } else {
          if (peerHandle) deps.relayStore.setDownstreamHandle(relay.id, peerHandle)
          deps.relayStore.setDownstreamRevealed(relay.id, now)
        }

        const sHandle = isUpstreamLeg ? (peerHandle ?? storedUpstreamHandle!) : storedUpstreamHandle!
        const qHandle = isUpstreamLeg ? storedDownstreamHandle! : (peerHandle ?? storedDownstreamHandle!)

        if (isUpstreamLeg) deps.completeDownstream(relay.downstream_agent_id, intentId, sHandle)
        else deps.completeUpstream(relay.upstream_agent_id, intentId, relay.relay_token, qHandle)
        deps.notify3way(intentId, sHandle, qHandle)
        return { mutual: true, handle: storedOtherHandle }
      }

      // Only this leg revealed → persist the caller's presented handle, mark it,
      // then nudge the un-revealed endpoint so its owner gets beat #2. Nudging S
      // must carry the relay_token; nudging Q must not.
      if (isUpstreamLeg) {
        if (peerHandle) deps.relayStore.setUpstreamHandle(relay.id, peerHandle)
        deps.relayStore.setUpstreamRevealed(relay.id, now)
      } else {
        if (peerHandle) deps.relayStore.setDownstreamHandle(relay.id, peerHandle)
        deps.relayStore.setDownstreamRevealed(relay.id, now)
      }

      if (isUpstreamLeg) deps.nudge(relay.downstream_agent_id, intentId)
      else deps.nudge(relay.upstream_agent_id, intentId, relay.relay_token)
      return { mutual: false }
    },
  }
}
