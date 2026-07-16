/**
 * social-pledge-store.ts — the answerer's mirror of an echo. When MY bot
 * answers someone ELSE's wish with match:'yes', it records a pledge so it can
 * later reveal back. There is no local social_seek parent (the wish is the
 * peer's), so it is its own table. Symmetric to social-echo-store.ts.
 */
import type { Db } from '../lib/db'

export interface PledgeRow {
  id: string; intent_id: string; seeker_agent_id: string; topic: string
  self_revealed_at: string | null; peer_revealed_at: string | null; created_at: string
}
export interface PledgeStore {
  create(p: { id: string; intentId: string; seekerAgentId: string; topic: string }): void
  get(id: string): PledgeRow | null
  list(): PledgeRow[]
  setSelfRevealed(id: string, at: string): void
  setPeerRevealed(id: string, at: string): void
}

export function makePledgeStore(db: Db): PledgeStore {
  const ins = db.query<unknown, [string, string, string, string, string]>(
    `INSERT INTO social_pledge(id, intent_id, seeker_agent_id, topic, self_revealed_at, peer_revealed_at, created_at)
     VALUES (?, ?, ?, ?, NULL, NULL, ?)`,
  )
  const selOne = db.query<PledgeRow, [string]>('SELECT * FROM social_pledge WHERE id = ?')
  const selAll = db.query<PledgeRow, []>('SELECT * FROM social_pledge ORDER BY created_at DESC, rowid DESC')
  const updSelf = db.query<unknown, [string, string]>('UPDATE social_pledge SET self_revealed_at = ? WHERE id = ?')
  const updPeer = db.query<unknown, [string, string]>('UPDATE social_pledge SET peer_revealed_at = ? WHERE id = ?')
  return {
    create(p) { ins.run(p.id, p.intentId, p.seekerAgentId, p.topic, new Date().toISOString()) },
    get(id) { return selOne.get(id) ?? null },
    list() { return selAll.all() },
    setSelfRevealed(id, at) { updSelf.run(at, id) },
    setPeerRevealed(id, at) { updPeer.run(at, id) },
  }
}
