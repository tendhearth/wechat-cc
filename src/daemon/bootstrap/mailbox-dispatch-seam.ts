/**
 * mailbox-dispatch-seam.ts — the small pure helpers wire-social uses to decide
 * whether an outbound social a2a call goes over the mailbox transport, and to
 * seal+drop it if so. Extracted so it's unit-testable without booting wireSocial.
 * See spec §3.3 / §6 (the third dispatch arm).
 */
import type { A2AAgentRecord } from '../../lib/agent-config'
import type { PeerMailbox, EnvelopeInner } from '../../core/mailbox-crypto'
import type { MailboxSender } from '../../core/mailbox-sender'

/** The peer's mailbox routing, or null if this peer isn't a (complete) mailbox peer. */
export function peerMailboxOf(hand: A2AAgentRecord): PeerMailbox | null {
  if (hand.transport !== 'mailbox') return null
  if (!hand.mailbox_addr || !hand.mailbox_enc_pub || !hand.relays || hand.relays.length === 0) return null
  return { addr: hand.mailbox_addr, enc_pub: hand.mailbox_enc_pub, relays: hand.relays }
}

/** Seal+drop `inner` to `peer` via the mailbox sender. Returns ok. */
export function dropToMailbox(sender: MailboxSender, peer: PeerMailbox, inner: EnvelopeInner): Promise<boolean> {
  return sender.send(inner, peer)
}
