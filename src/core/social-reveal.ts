/**
 * social-reveal.ts — the row-driven mutual reveal core (双向异步互揭). One
 * function, three entry points: revealEcho / revealPledge (outbound: my owner
 * clicked 揭晓) and onInboundReveal (a peer's /a2a/reveal arrived). Whoever
 * reveals SECOND learns mutual:true synchronously in their own round-trip; the
 * connection is two local rows on two machines, each side transitioning on
 * "both marked". No in-memory waiting — restart-survivability is a property of
 * the rows. See docs/superpowers/specs/2026-07-15-async-foraging-spine-design.md.
 */
import type { EchoStore } from './social-echo-store'
import type { PledgeStore } from './social-pledge-store'
import type { SeekStore } from './social-seek-store'

export interface PeerIdentity { name: string; url: string }
export type RevealBeat = 'first_echo' | 'await_reveal' | 'connected'
export interface NotifyCtx { intentId: string; peerAgentId?: string; peerName?: string }
export interface RevealOutcome { state: 'connected' | 'awaiting_peer' | 'peer_unreachable' }

export interface RevealerDeps {
  echoStore: EchoStore
  pledgeStore: PledgeStore
  seekStore: SeekStore
  /** Outbound A2A POST to the peer's /a2a/reveal. `relayToken` addresses a 2-hop
   *  relay leg (routed to the intermediary). null when unreachable. */
  postPeerReveal(agentId: string, intentId: string, relayToken?: string): Promise<{ mutual: boolean; identity?: PeerIdentity } | null>
  /** This daemon's public identity ({ name, url }) handed back on the mutual instant. */
  selfIdentity(): PeerIdentity
  /** Notification beats (克制三拍). Only await_reveal + connected fire from here. */
  notify(beat: RevealBeat, ctx: NotifyCtx): void
}

export interface Revealer {
  revealEcho(echoId: string): Promise<RevealOutcome | null>
  revealPledge(pledgeId: string): Promise<RevealOutcome | null>
  onInboundReveal(ev: { agentId: string; intentId: string; relayToken?: string; peerName?: string }): { mutual: boolean; identity?: PeerIdentity }
}

export function makeRevealer(deps: RevealerDeps): Revealer {
  return {
    async revealEcho(echoId) {
      const echo = deps.echoStore.get(echoId)
      if (!echo) return null
      if (echo.self_revealed_at && echo.peer_revealed_at) return { state: 'connected' }  // already mutual, no-op
      const now = new Date().toISOString()
      if (!echo.self_revealed_at) deps.echoStore.setSelfRevealed(echoId, now)             // my consent, idempotent
      // Relay (degree-2) echo → reveal is addressed to the intermediary (relay_via),
      // carrying the relay_token; a direct echo posts to peer_agent_id (2-arg, unchanged).
      const target = echo.relay_via ?? echo.peer_agent_id
      if (!target) return { state: 'peer_unreachable' }                                   // legacy row, can't POST back
      const resp = echo.relay_token
        ? await deps.postPeerReveal(target, echo.seek_id, echo.relay_token)
        : await deps.postPeerReveal(target, echo.seek_id)
      if (!resp) return { state: 'peer_unreachable' }                                     // consent already persisted
      if (!resp.mutual) return { state: 'awaiting_peer' }
      deps.echoStore.setPeerRevealed(echoId, now)
      deps.echoStore.setStatus(echoId, 'revealed')
      deps.seekStore.update(echo.seek_id, { status: 'connected' })
      if (resp.identity) deps.echoStore.setRevealedIdentity(echoId, resp.identity.name)
      deps.notify('connected', { intentId: echo.seek_id, peerName: resp.identity?.name })
      return { state: 'connected' }
    },

    async revealPledge(pledgeId) {
      const pledge = deps.pledgeStore.get(pledgeId)
      if (!pledge) return null
      if (pledge.self_revealed_at && pledge.peer_revealed_at) return { state: 'connected' }
      const now = new Date().toISOString()
      if (!pledge.self_revealed_at) deps.pledgeStore.setSelfRevealed(pledgeId, now)
      const resp = await deps.postPeerReveal(pledge.seeker_agent_id, pledge.intent_id)
      if (!resp) return { state: 'peer_unreachable' }
      if (!resp.mutual) return { state: 'awaiting_peer' }
      deps.pledgeStore.setPeerRevealed(pledgeId, now)
      deps.notify('connected', { intentId: pledge.intent_id, peerName: resp.identity?.name })
      return { state: 'connected' }
    },

    onInboundReveal({ agentId, intentId, relayToken, peerName }) {
      const now = new Date().toISOString()
      // Relay inbound → the relay echo id is intent_id:relay_via:relay_token (S may
      // hold several relay echoes for one intent, so the direct key is insufficient).
      const rowId = relayToken ? `${intentId}:${agentId}:${relayToken}` : `${intentId}:${agentId}`
      const echo = deps.echoStore.get(rowId)
      if (echo) {
        if (echo.peer_revealed_at) {
          // duplicate/retried inbound reveal — no writes, no notify, just a consistent answer
          return echo.self_revealed_at ? { mutual: true, identity: deps.selfIdentity() } : { mutual: false }
        }
        deps.echoStore.setPeerRevealed(rowId, now)
        if (echo.self_revealed_at) {
          deps.echoStore.setStatus(rowId, 'revealed')
          deps.seekStore.update(intentId, { status: 'connected' })
          // Relay completion: W hands the other endpoint's real name (the caller
          // agentId is W, not the counterpart, so we can't resolve it locally).
          if (peerName) deps.echoStore.setRevealedIdentity(rowId, peerName)
          deps.notify('connected', { intentId, peerAgentId: agentId, ...(peerName ? { peerName } : {}) })
          return { mutual: true, identity: deps.selfIdentity() }
        }
        deps.notify('await_reveal', { intentId, peerAgentId: agentId })
        return { mutual: false }
      }
      const pledge = deps.pledgeStore.get(rowId)
      if (pledge) {
        if (pledge.peer_revealed_at) {
          // duplicate/retried inbound reveal — no writes, no notify, just a consistent answer
          return pledge.self_revealed_at ? { mutual: true, identity: deps.selfIdentity() } : { mutual: false }
        }
        deps.pledgeStore.setPeerRevealed(rowId, now)
        if (pledge.self_revealed_at) {
          deps.notify('connected', { intentId, peerAgentId: agentId, ...(peerName ? { peerName } : {}) })
          return { mutual: true, identity: deps.selfIdentity() }
        }
        deps.notify('await_reveal', { intentId, peerAgentId: agentId })
        return { mutual: false }
      }
      return { mutual: false }  // nothing to reveal against; respond without leaking
    },
  }
}
