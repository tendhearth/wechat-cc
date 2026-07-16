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
}
export interface EchoStore {
  create(e: { id: string; seekId: string; peerMasked: string; degree: number; content: string; peerAgentId: string | null; relayVia?: string; relayToken?: string }): void
  setStatus(id: string, status: EchoRow['status']): void
  /** Write self_revealed_at (my consent leg). */
  setSelfRevealed(id: string, at: string): void
  /** Write peer_revealed_at (the peer revealed back). */
  setPeerRevealed(id: string, at: string): void
  /** Post-reveal: swap the masked placeholder for the peer's real name. */
  setRevealedIdentity(id: string, name: string): void
  listForSeek(seekId: string): EchoRow[]
  listAll(): EchoRow[]
  get(id: string): EchoRow | null
}

export function makeEchoStore(db: Db): EchoStore {
  const ins = db.query<unknown, [string, string, string, number, string, string, string | null, string | null, string | null]>(
    `INSERT INTO social_echo(id, seek_id, peer_masked, degree, content, status, created_at, peer_agent_id, relay_via, relay_token)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
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
  return {
    create(e) { ins.run(e.id, e.seekId, e.peerMasked, e.degree, e.content, new Date().toISOString(), e.peerAgentId, e.relayVia ?? null, e.relayToken ?? null) },
    setStatus(id, status) { updStatus.run(status, id) },
    setSelfRevealed(id, at) { updSelf.run(at, id) },
    setPeerRevealed(id, at) { updPeer.run(at, id) },
    setRevealedIdentity(id, name) { updIdentity.run(name, id) },
    listForSeek(seekId) { return selBySeek.all(seekId) },
    listAll() { return selAll.all() },
    get(id) { return selOne.get(id) ?? null },
  }
}
