/**
 * mailbox-letter-handler.ts — the OWN-CHANNEL-ONLY letter handler the mailbox
 * poller uses. Unlike the HTTP socialOnLetter, it NEVER falls through to
 * letterRelay.routeLetter: a mailbox drop carries no verified bearer, so it
 * must not be able to make W forward junk into its relay legs. Relay-direct
 * legitimate letters are always own-channel. See the plan's I1 resolution.
 */
import type { A2AServerOpts } from '../../core/a2a-server'

export function makeMailboxLetterHandler(deps: {
  getByMyChannelId: (channelId: string) => { id: string } | null | undefined
  receiveLetter: (ev: { channel_id: string; nonce: string; ct: string; tag: string }) => { ok: boolean; error?: string }
}): A2AServerOpts['onLetter'] {
  return async (ev) => deps.getByMyChannelId(ev.channel_id)
    ? deps.receiveLetter({ channel_id: ev.channel_id, nonce: ev.nonce, ct: ev.ct, tag: ev.tag })
    : { ok: false, error: 'unknown_channel' }
}
