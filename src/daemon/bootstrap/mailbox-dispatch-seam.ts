/**
 * mailbox-dispatch-seam.ts — the small pure helpers wire-social uses to decide
 * whether an outbound social a2a call goes over the mailbox transport, and to
 * seal+drop it if so. Extracted so it's unit-testable without booting wireSocial.
 * See spec §3.3 / §6 (the third dispatch arm).
 */
import type { A2AAgentRecord } from '../../lib/agent-config'
import type { PeerMailbox, EnvelopeInner } from '../../core/mailbox-crypto'
import type { MailboxSender } from '../../core/mailbox-sender'
import type { PenpalHandle } from '../../core/penpal-crypto'

/** The peer's mailbox routing, or null if this peer isn't a (complete) mailbox peer. */
export function peerMailboxOf(hand: A2AAgentRecord): PeerMailbox | null {
  if (hand.transport !== 'mailbox') return null
  if (!hand.mailbox_addr || !hand.mailbox_enc_pub || !hand.relays || hand.relays.length === 0) return null
  return { addr: hand.mailbox_addr, enc_pub: hand.mailbox_enc_pub, relays: hand.relays }
}

/**
 * C1 (Task 10) — the single home for building THIS daemon's crossing handle.
 * Enriches at the SOURCE (this daemon's own channel row + this daemon's own
 * mailbox identity), NOT from a bare channel row (which never held the
 * mailbox). Callers: wire-social's postPeerReveal (outbound POST), postReveal
 * implicitly (it forwards an already-enriched handle), and channel.openLocal
 * (the sync mutual-response path). `myMailbox` is undefined when this daemon
 * has no mailbox configured — the returned handle then omits `mailbox`
 * entirely, byte-identical to the pre-Task-10 handle (push peers unaffected).
 */
export function buildCrossedHandle(ch: { my_pubkey: string; my_channel_id: string }, myMailbox: PeerMailbox | undefined): PenpalHandle {
  return { pubkey: ch.my_pubkey, channel_id: ch.my_channel_id, ...(myMailbox ? { mailbox: myMailbox } : {}) }
}

/** Seal+drop `inner` to `peer` via the mailbox sender. Returns ok. */
export function dropToMailbox(sender: MailboxSender, peer: PeerMailbox, inner: EnvelopeInner): Promise<boolean> {
  return sender.send(inner, peer)
}
