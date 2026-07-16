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
  /** Outbound A2A POST to the peer's /a2a/reveal. null when unreachable. */
  postPeerReveal(agentId: string, intentId: string): Promise<{ mutual: boolean; identity?: PeerIdentity } | null>
  /** This daemon's public identity ({ name, url }) handed back on the mutual instant. */
  selfIdentity(): PeerIdentity
  /** Notification beats (克制三拍). Only await_reveal + connected fire from here. */
  notify(beat: RevealBeat, ctx: NotifyCtx): void
}

export interface Revealer {
  revealEcho(echoId: string): Promise<RevealOutcome | null>
  revealPledge(pledgeId: string): Promise<RevealOutcome | null>
  onInboundReveal(ev: { agentId: string; intentId: string }): { mutual: boolean; identity?: PeerIdentity }
}

export function makeRevealer(deps: RevealerDeps): Revealer {
  return {
    async revealEcho(echoId) {
      const echo = deps.echoStore.get(echoId)
      if (!echo) return null
      if (echo.self_revealed_at && echo.peer_revealed_at) return { state: 'connected' }  // already mutual, no-op
      const now = new Date().toISOString()
      if (!echo.self_revealed_at) deps.echoStore.setSelfRevealed(echoId, now)             // my consent, idempotent
      if (!echo.peer_agent_id) return { state: 'peer_unreachable' }                       // legacy row, can't POST back
      const resp = await deps.postPeerReveal(echo.peer_agent_id, echo.seek_id)
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

    onInboundReveal({ agentId, intentId }) {
      const now = new Date().toISOString()
      const rowId = `${intentId}:${agentId}`
      const echo = deps.echoStore.get(rowId)
      if (echo) {
        deps.echoStore.setPeerRevealed(rowId, now)
        if (echo.self_revealed_at) {
          deps.echoStore.setStatus(rowId, 'revealed')
          deps.seekStore.update(intentId, { status: 'connected' })
          deps.notify('connected', { intentId, peerAgentId: agentId })
          return { mutual: true, identity: deps.selfIdentity() }
        }
        deps.notify('await_reveal', { intentId, peerAgentId: agentId })
        return { mutual: false }
      }
      const pledge = deps.pledgeStore.get(rowId)
      if (pledge) {
        deps.pledgeStore.setPeerRevealed(rowId, now)
        if (pledge.self_revealed_at) {
          deps.notify('connected', { intentId, peerAgentId: agentId })
          return { mutual: true, identity: deps.selfIdentity() }
        }
        deps.notify('await_reveal', { intentId, peerAgentId: agentId })
        return { mutual: false }
      }
      return { mutual: false }  // nothing to reveal against; respond without leaking
    },
  }
}
