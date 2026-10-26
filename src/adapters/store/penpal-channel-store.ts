/**
 * penpal-channel-store.ts — the per-connection pen-pal channel. Holds this
 * side's LOCAL X25519 keypair + channel id, plus the peer's crossed handle
 * (pubkey + channel id), nullable until both sides have consented and the row
 * flips to `open` (pairing.ts's adoptPeerCard does that in one go, for both the
 * 配对 `pair:` rows and 介绍's `intro:` rows).
 * NO real identity is ever stored — the peer is only ever a pubkey + an opaque
 * channel address.
 */
import type { Db } from '../../lib/db'
import type { ChannelRow, ChannelStore } from '../../ports/penpal-channel'
import type { PeerMailbox } from '../../ports/mailbox'

export function makeChannelStore(db: Db): ChannelStore {
  const ins = db.query<unknown, [string, string, string, string, string, number, string | null, string | null, string]>(
    `INSERT INTO penpal_channel(id, seek_id, my_privkey, my_pubkey, my_channel_id, degree, relay_via, peer_agent_id, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  )
  const selOne = db.query<ChannelRow, [string]>('SELECT * FROM penpal_channel WHERE id = ?')
  const selByChan = db.query<ChannelRow, [string]>('SELECT * FROM penpal_channel WHERE my_channel_id = ?')
  const selAll = db.query<ChannelRow, []>('SELECT * FROM penpal_channel ORDER BY created_at DESC, rowid DESC')
  const updPeer = db.query<unknown, [string, string, string | null, string]>(
    `UPDATE penpal_channel SET peer_pubkey = ?, peer_channel_id = ?, peer_mailbox = ? WHERE id = ?`,
  )
  const updStatus = db.query<unknown, [string, string]>('UPDATE penpal_channel SET status = ? WHERE id = ?')
  return {
    create(c) { ins.run(c.id, c.seekId, c.myPrivkey, c.myPubkey, c.myChannelId, c.degree, c.relayVia ?? null, c.peerAgentId ?? null, new Date().toISOString()) },
    get(id) { return selOne.get(id) ?? null },
    getByMyChannelId(channelId) { return selByChan.get(channelId) ?? null },
    setPeerHandle(id, handle) {
      updPeer.run(handle.pubkey, handle.channel_id, handle.mailbox ? JSON.stringify(handle.mailbox) : null, id)
    },
    setStatus(id, status) { updStatus.run(status, id) },
    list() { return selAll.all() },
  }
}

/** Parses the row's stored `peer_mailbox` JSON back into a `PeerMailbox`, or
 *  `null` when the peer never crossed one (nullable until a relay-direct
 *  reveal — see Task 10's C1 fix). Consumed by the relay-direct letter path. */
export function peerMailboxOfRow(row: ChannelRow): PeerMailbox | null {
  return row.peer_mailbox ? JSON.parse(row.peer_mailbox) as PeerMailbox : null
}
