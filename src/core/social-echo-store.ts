/**
 * social-echo-store.ts — persisted "postcards" that came back for a seek
 * (觅食台 P1). Masked peer identity until dual-confirm reveal; the async
 * foraging spine adds peer_agent_id (server-side only, needed to POST the
 * peer's /a2a/reveal) + the two reveal timestamps.
 */
import type { Db } from '../lib/db'

export interface EchoRow {
  id: string; seek_id: string; peer_masked: string; degree: number
  content: string; status: 'pending' | 'revealed' | 'declined'; created_at: string
  peer_agent_id: string | null
  self_revealed_at: string | null
  peer_revealed_at: string | null
  relay_via: string | null
  relay_token: string | null
  /** 我的揭晓**真的送到对端**的时刻 —— 与 self_revealed_at(我的 owner
   *  同意)是两件事。见 db.ts v32 / social-reveal.ts。 */
  self_reveal_delivered_at: string | null
}
/**
 * Public projection of an EchoRow — safe to send to the frontend pre-reveal.
 * Explicit ALLOWLIST (not a denylist) so a future sensitive field on EchoRow
 * doesn't leak by default: peer_agent_id (the answerer's real agent id),
 * relay_via (the intermediary's real agent id) and relay_token (opaque
 * server routing) are deliberately excluded. Post-reveal, peer_masked
 * already holds the real name, so the real identity still surfaces then —
 * correctly, since both sides opted in.
 */
export interface PublicEchoRow {
  id: string; seek_id: string; peer_masked: string; degree: number
  content: string; status: EchoRow['status']; created_at: string
  self_revealed_at: string | null
  peer_revealed_at: string | null
}

export function toPublicEcho(r: EchoRow): PublicEchoRow {
  return {
    id: r.id, seek_id: r.seek_id, peer_masked: r.peer_masked, degree: r.degree,
    content: r.content, status: r.status, created_at: r.created_at,
    self_revealed_at: r.self_revealed_at, peer_revealed_at: r.peer_revealed_at,
  }
}

export interface EchoStore {
  create(e: { id: string; seekId: string; peerMasked: string; degree: number; content: string; peerAgentId: string | null; relayVia?: string; relayToken?: string }): void
  setStatus(id: string, status: EchoRow['status']): void
  /** Write self_revealed_at (my consent leg). */
  setSelfRevealed(id: string, at: string): void
  /** Write peer_revealed_at (the peer revealed back). */
  setPeerRevealed(id: string, at: string): void
  /** 记下「我的揭晓已送达」。只在 postPeerReveal 返回非 null 之后调用。 */
  setSelfDelivered(id: string, at: string): void
  /** 我已同意、但揭晓从没送出去的行 —— 补投扫描的输入。 */
  listUndelivered(): EchoRow[]
  /** Post-reveal: swap the masked placeholder for the peer's real name. */
  setRevealedIdentity(id: string, name: string): void
  listForSeek(seekId: string): EchoRow[]
  listAll(): EchoRow[]
  get(id: string): EchoRow | null
}

export function makeEchoStore(db: Db): EchoStore {
  const ins = db.query<unknown, [string, string, string, number, string, string, string | null, string | null, string | null]>(
    // 主键是确定性的(`intent:peerAgent`,中继回声则 `intent:relayVia:relayToken`),
    // 信箱是 at-least-once,重放带来的行与原行完全一样 —— 见 social-pledge-store
    // 的同款说明。DO NOTHING 而非 DO UPDATE:status / self_revealed_at /
    // peer_revealed_at / peer_masked(揭晓后会被换成真名)都可能已经更新过。
    `INSERT INTO social_echo(id, seek_id, peer_masked, degree, content, status, created_at, peer_agent_id, relay_via, relay_token)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  )
  const selOne = db.query<EchoRow, [string]>('SELECT * FROM social_echo WHERE id = ?')
  const selBySeek = db.query<EchoRow, [string]>(
    'SELECT * FROM social_echo WHERE seek_id = ? ORDER BY created_at DESC, rowid DESC',
  )
  const selAll = db.query<EchoRow, []>('SELECT * FROM social_echo ORDER BY created_at DESC, rowid DESC')
  const updStatus = db.query<unknown, [string, string]>('UPDATE social_echo SET status = ? WHERE id = ?')
  const updSelf = db.query<unknown, [string, string]>('UPDATE social_echo SET self_revealed_at = ? WHERE id = ?')
  const updPeer = db.query<unknown, [string, string]>('UPDATE social_echo SET peer_revealed_at = ? WHERE id = ?')
  const updIdentity = db.query<unknown, [string, string]>('UPDATE social_echo SET peer_masked = ? WHERE id = ?')
  const updDelivered = db.query<unknown, [string, string]>('UPDATE social_echo SET self_reveal_delivered_at = ? WHERE id = ?')
  const selUndelivered = db.query<EchoRow, []>(
    'SELECT * FROM social_echo WHERE self_revealed_at IS NOT NULL AND self_reveal_delivered_at IS NULL ORDER BY created_at ASC, rowid ASC',
  )
  return {
    create(e) { ins.run(e.id, e.seekId, e.peerMasked, e.degree, e.content, new Date().toISOString(), e.peerAgentId, e.relayVia ?? null, e.relayToken ?? null) },
    setStatus(id, status) { updStatus.run(status, id) },
    setSelfRevealed(id, at) { updSelf.run(at, id) },
    setPeerRevealed(id, at) { updPeer.run(at, id) },
    setRevealedIdentity(id, name) { updIdentity.run(name, id) },
    setSelfDelivered(id, at) { updDelivered.run(at, id) },
    listUndelivered() { return selUndelivered.all() },
    listForSeek(seekId) { return selBySeek.all(seekId) },
    listAll() { return selAll.all() },
    get(id) { return selOne.get(id) ?? null },
  }
}
