/**
 * 笔友信道的口(架构终态 E5):每条连接一行的信道(我方 X25519 密钥对 + 收信地址、对方交叉过来的句柄)。
 * 实现在 src/adapters/store/penpal-channel-store.ts;app(配对、关系视图)只经这里认它的形状。
 * 「一个对方只留一条」的收敛是纯函数,在 src/domain/penpal-channels.ts。只有类型,没有逻辑。
 */

/** A per-connection pseudonym crossed at reveal: an ephemeral pubkey + the
 *  opaque channel id the holder listens on. Contains NO real identity.
 *  `mailbox` is OPTIONAL relay-direct-letter routing (structurally mirrors
 *  `PeerMailbox` in ports/mailbox.ts; inlined here to avoid a cross-module
 *  import cycle). Additive plumbing only — nothing populates it yet; see
 *  Task 10's C1 fix. */
export interface PenpalHandle {
  pubkey: string
  channel_id: string
  mailbox?: { addr: string; enc_pub: string; relays: string[] }
}

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
