/**
 * penpal-channel-store.ts — the per-connection pen-pal channel. Mirrors the
 * social store idiom (social-echo-store.ts). Holds this side's LOCAL X25519
 * keypair + channel id, plus the peer's crossed handle (pubkey + channel id),
 * nullable until the mutual reveal opens the channel. NO real identity is ever
 * stored — the peer is only ever a pubkey + an opaque channel address.
 */
import type { Db } from '../lib/db'
import type { PenpalHandle } from './penpal-crypto'
import type { PeerMailbox } from './mailbox-crypto'

export interface ChannelRow {
  id: string; seek_id: string; my_privkey: string; my_pubkey: string; my_channel_id: string
  peer_pubkey: string | null; peer_channel_id: string | null; peer_mailbox: string | null
  degree: number; relay_via: string | null; peer_agent_id: string | null
  status: 'pending' | 'open'; created_at: string
}
export interface ChannelStore {
  create(c: { id: string; seekId: string; myPrivkey: string; myPubkey: string; myChannelId: string; degree: number; relayVia?: string | null; peerAgentId?: string | null }): void
  get(id: string): ChannelRow | null
  getByMyChannelId(channelId: string): ChannelRow | null
  setPeerHandle(id: string, handle: PenpalHandle): void
  setStatus(id: string, status: ChannelRow['status']): void
  list(): ChannelRow[]
}

export function makeChannelStore(db: Db): ChannelStore {
  const ins = db.query<unknown, [string, string, string, string, string, number, string | null, string | null, string]>(
    `INSERT INTO penpal_channel(id, seek_id, my_privkey, my_pubkey, my_channel_id, degree, relay_via, peer_agent_id, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  )
  const selOne = db.query<ChannelRow, [string]>('SELECT * FROM penpal_channel WHERE id = ?')
  const selByChan = db.query<ChannelRow, [string]>('SELECT * FROM penpal_channel WHERE my_channel_id = ?')
  const selAll = db.query<ChannelRow, []>('SELECT * FROM penpal_channel ORDER BY created_at DESC, rowid DESC')
  const updPeer = db.query<unknown, [string, string, string | null, string]>(
    `UPDATE penpal_channel SET peer_pubkey = ?, peer_channel_id = ?, peer_mailbox = ?, status = 'open' WHERE id = ?`,
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
