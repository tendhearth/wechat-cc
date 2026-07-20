/**
 * postletter-route.ts — the letter routing decision: a channel with a crossed
 * peer mailbox goes relay-direct (seal+drop, W exits the loop); a push-only
 * peer falls through to A's Task-9 push/W-forward. See spec §3.5 / brief #9.
 */
import type { PeerMailbox } from '../../core/mailbox-crypto'

export type PostLetterBody = { channel_id: string; nonce: string; ct: string; tag: string }
export type PostLetterTarget = { agentId: string; relayVia: string | null; mailbox?: PeerMailbox }

export function makeRoutePostLetter(deps: {
  mailboxSend: (inner: { path: string; bearer: string; body: unknown }, peer: PeerMailbox) => Promise<boolean>
  pushSend: (target: PostLetterTarget, body: PostLetterBody) => Promise<boolean>
  selfId: string
}): (target: PostLetterTarget, body: PostLetterBody) => Promise<boolean> {
  return (target, body) => target.mailbox
    // `bearer: deps.selfId` here is unused by the recipient — unlike
    // postReveal's mailbox branch (bearer: hand.outbound_api_key),
    // /a2a/letter's mailbox-dispatch path skips verifyBearer by design: the
    // recipient's makeMailboxLetterHandler/receiveLetter authenticates via
    // the channel-key AES-GCM open (content-blind E2E), not the bearer. Kept
    // as selfId (not churned) so the field is at least a legible caller id.
    ? deps.mailboxSend({ path: '/a2a/letter', bearer: deps.selfId, body: { agent_id: deps.selfId, ...body } }, target.mailbox)
    : deps.pushSend(target, body)
}
