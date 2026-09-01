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
          // null ≠ 空信箱。client.fetch 把超时、非 2xx、网络错误全塌缩成
          // null(见 mailbox-client.ts),和「今天没来信」并成一条静默路径
          // 的话,取不到信时日志里什么都没有 —— 真机上就是这样卡住的。
          // 空信箱继续保持安静(每 2 分钟一条噪音没人看)。
          // 具体成因由 client 的 onError 单独打一行(超时 / HTTP 码 / 网络)。
          if (!page) {
            deps.log('MAILBOX', `poll relay=${relay} 取不到信 —— 本轮跳过,游标不动`)
            continue
          }
          if (page.items.length === 0) continue
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
