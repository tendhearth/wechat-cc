/**
 * penpal-relay-letter.ts — the INTERMEDIARY's (介绍人 / W) content-blind
 * letter router for a 2-hop pen-pal channel (spec #2, Task 9). When an
 * inbound POST /a2a/letter's channel_id is NOT one of W's own open channels
 * (W is not the endpoint), it must belong to one of the relay legs W
 * brokered at reveal-crossing (Task 5/8): S's own channel_id (upstream_handle)
 * or Q's own channel_id (downstream_handle). Whichever leg's channel_id the
 * inbound letter is addressed to IS the far endpoint — W resolves its agent
 * id and re-posts the SAME sealed body onward, unopened.
 *
 * W is strictly content-blind: this module imports no crypto, holds no key,
 * and never calls openLetter. It only routes ciphertext by channel_id.
 * See docs/superpowers/specs/2026-07-18-anonymous-penpal-social-layer-design.md.
 */
import type { RelayStore } from './social-relay-store'
import type { PenpalHandle } from './penpal-crypto'
import type { LetterEvent } from './a2a-server'
import type { PeerMailbox } from './mailbox-crypto'

export interface LetterRelayDeps {
  relayStore: RelayStore
  /** Forward the sealed letter onward, unopened. relayVia: null — this leg's
   *  hop ends at the far endpoint's own registered a2a address; W does not
   *  chain through a further relay. W is always forwarding to a push peer, so
   *  it never sets `mailbox` — the widened target type (Task 11) is shared
   *  with penpal-correspondent.ts's postLetter for the "consistency of
   *  names" rule, but this leg's target is always mailbox-less. */
  postLetter(target: { agentId: string; relayVia: string | null; mailbox?: PeerMailbox }, body: { channel_id: string; nonce: string; ct: string; tag: string }): Promise<boolean>
}

export interface LetterRelay {
  routeLetter(event: LetterEvent): Promise<{ ok: boolean; error?: string }>
}

export function makeLetterRelay(deps: LetterRelayDeps): LetterRelay {
  return {
    async routeLetter(event) {
      const relay = deps.relayStore.getByEndpointChannelId(event.channel_id)
      if (!relay) return { ok: false, error: 'unknown_channel' }

      const upstreamHandle: PenpalHandle | null = relay.upstream_handle ? JSON.parse(relay.upstream_handle) : null
      const downstreamHandle: PenpalHandle | null = relay.downstream_handle ? JSON.parse(relay.downstream_handle) : null

      // The leg whose OWN presented channel_id matches the inbound address is
      // the far endpoint this letter is addressed to (letters are always
      // addressed by the recipient's own channel_id — see penpal-correspondent.ts
      // sendLetter, which posts `channel_id: ch.peer_channel_id`).
      let farAgentId: string
      if (upstreamHandle?.channel_id === event.channel_id) farAgentId = relay.upstream_agent_id
      else if (downstreamHandle?.channel_id === event.channel_id) farAgentId = relay.downstream_agent_id
      else return { ok: false, error: 'unknown_channel' }

      // Loop-safety: never forward a letter back to the same party that sent
      // it (shouldn't occur under normal protocol — S and Q's own channel_ids
      // are distinct from the sender's identity — but guard anyway).
      if (farAgentId === event.agent_id) return { ok: false, error: 'unknown_channel' }

      // TODO(sub-project C): budget.consume(relay_token) gate before re-posting

      const ok = await deps.postLetter(
        { agentId: farAgentId, relayVia: null, mailbox: undefined },
        { channel_id: event.channel_id, nonce: event.nonce, ct: event.ct, tag: event.tag },
      )
      return ok ? { ok: true } : { ok: false, error: 'forward_failed' }
    },
  }
}
