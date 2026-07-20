/**
 * mailbox-poller.ts — one scheduler tick: for each configured relay, fetch our
 * mailbox since the persisted cursor (Ed25519-signed), open each sealed
 * envelope with our X25519 mailbox key, replay {path,bearer,body} into the
 * existing inbound handlers, then ack + persist the cursor. Malformed /
 * undecryptable envelopes are silently skipped (GCM failure = not for us /
 * tampered). Never throws. See spec §3.3 / §5.
 */
import { openEnvelope, signFetch, signAck, type MailboxIdentity, type Envelope } from './mailbox-crypto'
import type { MailboxClient } from './mailbox-client'
import type { EnvelopeDispatch } from './mailbox-dispatch'
import type { CursorStore } from './mailbox-cursor-store'

export function makeMailboxPoller(deps: {
  identity: MailboxIdentity
  relays: string[]
  client: MailboxClient
  dispatch: EnvelopeDispatch
  cursors: CursorStore
  log: (tag: string, line: string) => void
}): { onTick(): Promise<void> } {
  return {
    async onTick() {
      for (const relay of deps.relays) {
        try {
          const ts = Date.now()
          const since = deps.cursors.get(relay)
          const page = await deps.client.fetch(relay, deps.identity.addr, since, ts, signFetch(deps.identity.sign, deps.identity.addr, ts))
          if (!page || page.items.length === 0) continue
          for (const item of page.items) {
            let env: Envelope
            try { env = JSON.parse(item.envelope) as Envelope } catch { continue }   // relay stored an opaque string; skip non-JSON
            const inner = openEnvelope(deps.identity.enc_priv, env)
            if (!inner) continue   // undecryptable = not for us / tampered — silent drop
            await deps.dispatch.dispatch(inner)
          }
          const ackTs = Date.now()
          await deps.client.ack(relay, deps.identity.addr, page.next_cursor, ackTs, signAck(deps.identity.sign, deps.identity.addr, page.next_cursor, ackTs))
          deps.cursors.set(relay, page.next_cursor)
        } catch (err) {
          deps.log('MAILBOX', `poll relay=${relay} failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    },
  }
}
