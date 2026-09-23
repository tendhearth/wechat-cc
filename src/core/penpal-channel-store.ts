/**
 * penpal-channel-store.ts — the per-connection pen-pal channel. Holds this
 * side's LOCAL X25519 keypair + channel id, plus the peer's crossed handle
 * (pubkey + channel id), nullable until both sides have consented and the row
 * flips to `open` (pairing.ts's adoptPeerCard does that in one go, for both the
 * 配对 `pair:` rows and 介绍's `intro:` rows).
 * NO real identity is ever stored — the peer is only ever a pubkey + an opaque
 * channel address.
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
  /** Stores the peer's crossed handle. Deliberately does NOT touch `status`:
   *  the handle can legitimately land BEFORE my own consent (the peer revealed
   *  first, and an async transport gives no second chance to deliver it), and a
   *  channel must never read as `open` — the 信箱 surface filters on exactly
   *  that — until both sides have consented. Opening is an explicit
   *  `setStatus(id, 'open')` at the mutual instant. */
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

/**
 * 「一个对方一条信道」的那一条 —— 每个 `peer_agent_id` 只留**最新的那条 open
 * 行**,其余(旧的、pending 的)全滤掉。
 *
 * WHY:重新配对总是按 initiator nonce 建新行(两侧才对称),所以同一个对端
 * 完全可能有好几条 open 行。不收敛的话,一条心愿会往同一个人那儿投 N 次
 * (他的主人被打扰 N 次),关系视图里同一个朋友也会出现 N 遍。
 *
 * `peer_agent_id` 为空(经介绍人的匿名信道)一律保留 —— 它们没有「同一个人」
 * 可言,各是各的。同 `created_at` 时保留**先出现的那条**:store 的 list() 是
 * `created_at DESC, rowid DESC`,先出现的就是新的。
 */
export function primaryChannels<T extends { peer_agent_id?: string | null; status: string; created_at?: string }>(rows: readonly T[]): T[] {
  const newest = new Map<string, T>()
  for (const r of rows) {
    const pid = r.peer_agent_id
    if (r.status !== 'open' || pid === null || pid === undefined) continue
    const cur = newest.get(pid)
    if (!cur || (r.created_at ?? '') > (cur.created_at ?? '')) newest.set(pid, r)
  }
  const pid = (r: T): string | null | undefined => r.peer_agent_id
  return rows.filter(r => r.status === 'open' && (pid(r) === null || pid(r) === undefined || newest.get(pid(r)!) === r))
}

/** Parses the row's stored `peer_mailbox` JSON back into a `PeerMailbox`, or
 *  `null` when the peer never crossed one (nullable until a relay-direct
 *  reveal — see Task 10's C1 fix). Consumed by the relay-direct letter path. */
export function peerMailboxOfRow(row: ChannelRow): PeerMailbox | null {
  return row.peer_mailbox ? JSON.parse(row.peer_mailbox) as PeerMailbox : null
}
