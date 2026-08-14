/**
 * social-reveal.ts — the row-driven mutual reveal core (双向异步互揭). One
 * function, three entry points: revealEcho / revealPledge (outbound: my owner
 * clicked 揭晓) and onInboundReveal (a peer's /a2a/reveal arrived). Whoever
 * reveals SECOND learns mutual:true synchronously in their own round-trip; the
 * connection is two local rows on two machines, each side transitioning on
 * "both marked". No in-memory waiting — restart-survivability is a property of
 * the rows. See docs/superpowers/specs/2026-07-15-async-foraging-spine-design.md.
 *
 * Reveal crosses a per-connection PenpalHandle (X25519 pubkey + channel id),
 * never the real peer identity — see
 * docs/superpowers/specs/2026-07-18-anonymous-penpal-social-layer-design.md.
 * The masked label (第 N 度的某人) is permanent; only the ChannelPort, backed
 * by the channel store, learns the crossed handle.
 */
import type { EchoStore } from './social-echo-store'
import type { PledgeStore } from './social-pledge-store'
import type { SeekStore } from './social-seek-store'
import type { PenpalHandle } from './penpal-crypto'

export type { PenpalHandle } from './penpal-crypto'
export type RevealBeat = 'first_echo' | 'await_reveal' | 'connected'
export interface NotifyCtx { intentId: string; peerAgentId?: string }
export interface RevealOutcome { state: 'connected' | 'awaiting_peer' | 'peer_unreachable' }

/** A small channel-store seam so the revealer stays pure (no DB knowledge).
 *  Backed by `makeChannelStore` (Task 6). */
export interface ChannelPort {
  /** Called at the ①→② opt-in (my consent) — idempotent: mint a keypair +
   *  channel id and a pending channel row keyed by `rowId` if absent, return
   *  THIS side's PenpalHandle. */
  openLocal(rowId: string, ctx: { seekId: string; degree: number; peerAgentId?: string | null; relayVia?: string | null }): PenpalHandle
  /** Called at the mutual instant: store the peer's crossed handle, status→open. */
  finalize(rowId: string, peerHandle: PenpalHandle): void
}

export interface RevealerDeps {
  echoStore: EchoStore
  pledgeStore: PledgeStore
  seekStore: SeekStore
  /** Outbound A2A POST to the peer's /a2a/reveal. `relayToken` addresses a 2-hop
   *  relay leg (routed to the intermediary). null when unreachable. */
  postPeerReveal(agentId: string, intentId: string, relayToken?: string): Promise<{ mutual: boolean; handle?: PenpalHandle } | null>
  /** Channel port: mints/persists the per-connection PenpalHandle. */
  channel: ChannelPort
  /** Notification beats (克制三拍). Only await_reveal + connected fire from here. */
  notify(beat: RevealBeat, ctx: NotifyCtx): void
}

export interface Revealer {
  revealEcho(echoId: string): Promise<RevealOutcome | null>
  revealPledge(pledgeId: string): Promise<RevealOutcome | null>
  onInboundReveal(ev: { agentId: string; intentId: string; relayToken?: string; peerHandle?: PenpalHandle }): { mutual: boolean; handle?: PenpalHandle }
}

export function makeRevealer(deps: RevealerDeps): Revealer {
  return {
    async revealEcho(echoId) {
      const echo = deps.echoStore.get(echoId)
      if (!echo) return null
      if (echo.self_revealed_at && echo.peer_revealed_at) return { state: 'connected' }  // already mutual, no-op
      const now = new Date().toISOString()
      if (!echo.self_revealed_at) {
        deps.echoStore.setSelfRevealed(echoId, now)                                       // my consent, idempotent
        deps.channel.openLocal(echoId, { seekId: echo.seek_id, degree: echo.degree, peerAgentId: echo.peer_agent_id, relayVia: echo.relay_via })
      }
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
      if (resp.handle) deps.channel.finalize(echoId, resp.handle)
      deps.notify('connected', { intentId: echo.seek_id })
      return { state: 'connected' }
    },

    async revealPledge(pledgeId) {
      const pledge = deps.pledgeStore.get(pledgeId)
      if (!pledge) return null
      if (pledge.self_revealed_at && pledge.peer_revealed_at) return { state: 'connected' }
      const now = new Date().toISOString()
      if (!pledge.self_revealed_at) {
        deps.pledgeStore.setSelfRevealed(pledgeId, now)
        deps.channel.openLocal(pledgeId, { seekId: pledge.intent_id, degree: 0, peerAgentId: pledge.seeker_agent_id, relayVia: null })
      }
      const resp = await deps.postPeerReveal(pledge.seeker_agent_id, pledge.intent_id)
      if (!resp) return { state: 'peer_unreachable' }
      if (!resp.mutual) return { state: 'awaiting_peer' }
      deps.pledgeStore.setPeerRevealed(pledgeId, now)
      if (resp.handle) deps.channel.finalize(pledgeId, resp.handle)
      deps.notify('connected', { intentId: pledge.intent_id })
      return { state: 'connected' }
    },

    onInboundReveal({ agentId, intentId, relayToken, peerHandle }) {
      const now = new Date().toISOString()
      // Relay inbound → the relay echo id is intent_id:relay_via:relay_token (S may
      // hold several relay echoes for one intent, so the direct key is insufficient).
      const rowId = relayToken ? `${intentId}:${agentId}:${relayToken}` : `${intentId}:${agentId}`
      const echo = deps.echoStore.get(rowId)
      if (echo) {
        if (echo.peer_revealed_at) {
          // duplicate/retried inbound reveal — no writes, no notify, just a consistent answer
          if (!echo.self_revealed_at) return { mutual: false }
          const handle = deps.channel.openLocal(rowId, { seekId: intentId, degree: echo.degree, peerAgentId: echo.peer_agent_id, relayVia: echo.relay_via })
          if (peerHandle) deps.channel.finalize(rowId, peerHandle)
          return { mutual: true, handle }
        }
        deps.echoStore.setPeerRevealed(rowId, now)
        if (echo.self_revealed_at) {
          deps.echoStore.setStatus(rowId, 'revealed')
          deps.seekStore.update(intentId, { status: 'connected' })
          // Idempotent openLocal mints/returns MY handle at the mutual instant; the
          // peer's presented handle (if any) is stored via finalize now that the
          // channel row exists (opened at my earlier self-reveal, or here for the
          // first time if I'm revealing second synchronously).
          const handle = deps.channel.openLocal(rowId, { seekId: intentId, degree: echo.degree, peerAgentId: echo.peer_agent_id, relayVia: echo.relay_via })
          if (peerHandle) deps.channel.finalize(rowId, peerHandle)
          deps.notify('connected', { intentId, peerAgentId: agentId })
          return { mutual: true, handle }
        }
        // Peer revealed before me — I have no channel row yet, so their presented
        // handle can't be persisted. It is intentionally re-delivered later via the
        // mutual response ({ mutual: true, handle }) once I reveal second.
        deps.notify('await_reveal', { intentId, peerAgentId: agentId })
        return { mutual: false }
      }
      const pledge = deps.pledgeStore.get(rowId)
      if (pledge) {
        if (pledge.peer_revealed_at) {
          // duplicate/retried inbound reveal — no writes, no notify, just a consistent answer
          if (!pledge.self_revealed_at) return { mutual: false }
          const handle = deps.channel.openLocal(rowId, { seekId: intentId, degree: 0, peerAgentId: pledge.seeker_agent_id, relayVia: null })
          if (peerHandle) deps.channel.finalize(rowId, peerHandle)
          return { mutual: true, handle }
        }
        deps.pledgeStore.setPeerRevealed(rowId, now)
        if (pledge.self_revealed_at) {
          const handle = deps.channel.openLocal(rowId, { seekId: intentId, degree: 0, peerAgentId: pledge.seeker_agent_id, relayVia: null })
          if (peerHandle) deps.channel.finalize(rowId, peerHandle)
          deps.notify('connected', { intentId, peerAgentId: agentId })
          return { mutual: true, handle }
        }
        deps.notify('await_reveal', { intentId, peerAgentId: agentId })
        return { mutual: false }
      }
      return { mutual: false }  // nothing to reveal against; respond without leaking
    },
  }
}
