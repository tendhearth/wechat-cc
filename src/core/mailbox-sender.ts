/**
 * mailbox-sender.ts — the `transport: mailbox` send path: seal {path,bearer,body}
 * to the peer's enc_pub and drop the opaque envelope into each of the peer's
 * relays. The third dispatch arm alongside push (a2a-client) and ws (YiHub).
 * See spec §3.3 / §6.
 */
import { sealEnvelope, type EnvelopeInner, type PeerMailbox } from './mailbox-crypto'
import type { MailboxClient } from './mailbox-client'

export interface MailboxSender { send(inner: EnvelopeInner, peer: PeerMailbox): Promise<boolean> }

export function makeMailboxSender(deps: { client: MailboxClient }): MailboxSender {
  return {
    async send(inner, peer) {
      const envelope = JSON.stringify(sealEnvelope(inner, peer.enc_pub))
      const results = await Promise.all(peer.relays.map(r => deps.client.drop(r, peer.addr, envelope)))
      return results.some(Boolean)   // v0: success = dropped into at least one relay
    },
  }
}
