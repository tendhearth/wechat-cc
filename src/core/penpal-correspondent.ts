/**
 * penpal-correspondent.ts — seals outbound letters and opens + persists
 * inbound ones for an open pen-pal channel. Plaintext NEVER goes on the wire:
 * only the sealed fields (nonce/ct/tag) + the peer's channel_id cross; the
 * local `plaintext` column on penpal_letter is for the owner's thread only.
 * See docs/superpowers/specs/2026-07-18-anonymous-penpal-social-layer-design.md.
 */
import { randomUUID } from 'node:crypto'
import type { ChannelStore } from './penpal-channel-store'
import type { LetterStore } from './penpal-letter-store'
import { deriveSharedKey, sealLetter, openLetter } from './penpal-crypto'

export interface CorrespondentDeps {
  channelStore: ChannelStore
  letterStore: LetterStore
  /** Outbound: POST the sealed letter to the peer over a2a. relayVia routes a
   *  2-hop channel through the intermediary (Task 9). channel_id = the PEER's
   *  inbound address. Returns ok. */
  postLetter(target: { agentId: string; relayVia: string | null }, body: { channel_id: string; nonce: string; ct: string; tag: string }): Promise<boolean>
  /** Owner notification on an inbound letter (preview of the decrypted text). */
  notifyInbound(channelRowId: string, preview: string): void
}

export interface Correspondent {
  sendLetter(channelRowId: string, plaintext: string): Promise<{ ok: boolean; error?: string }>
  receiveLetter(event: { channel_id: string; nonce: string; ct: string; tag: string }): { ok: boolean; error?: string }
}

export function makeCorrespondent(deps: CorrespondentDeps): Correspondent {
  return {
    sendLetter(channelRowId, plaintext) {
      const ch = deps.channelStore.get(channelRowId)
      if (!ch || ch.status !== 'open' || !ch.peer_pubkey || !ch.peer_channel_id) return Promise.resolve({ ok: false, error: 'channel_not_open' })
      // Relay (degree-2) letters post to the intermediary (relay_via) so the 2-hop
      // path stays content-blind — the intermediary routes the ciphertext onward
      // without seeing it; direct letters post straight to peer_agent_id.
      // Mirrors social-reveal.ts's `echo.relay_via ?? echo.peer_agent_id`.
      const agentId = ch.relay_via ?? ch.peer_agent_id
      if (!agentId) return Promise.resolve({ ok: false, error: 'no_route' })
      const key = deriveSharedKey(ch.my_privkey, ch.peer_pubkey)
      const sealed = sealLetter(key, plaintext)
      deps.letterStore.create({ id: randomUUID(), channelId: channelRowId, direction: 'out', sealedCiphertext: sealed.ct, nonce: sealed.nonce, tag: sealed.tag, plaintext })
      return deps.postLetter({ agentId, relayVia: ch.relay_via }, { channel_id: ch.peer_channel_id, nonce: sealed.nonce, ct: sealed.ct, tag: sealed.tag })
        .then(ok => ok ? { ok: true } : { ok: false, error: 'send_failed' })
    },
    receiveLetter(ev) {
      const ch = deps.channelStore.getByMyChannelId(ev.channel_id)
      if (!ch || ch.status !== 'open' || !ch.peer_pubkey) return { ok: false, error: 'unknown_channel' }
      try {
        const pt = openLetter(deriveSharedKey(ch.my_privkey, ch.peer_pubkey), { nonce: ev.nonce, ct: ev.ct, tag: ev.tag })
        deps.letterStore.create({ id: randomUUID(), channelId: ch.id, direction: 'in', sealedCiphertext: ev.ct, nonce: ev.nonce, tag: ev.tag, plaintext: pt })
        deps.notifyInbound(ch.id, pt.slice(0, 40))
        return { ok: true }
      } catch { return { ok: false, error: 'open_failed' } }
    },
  }
}
