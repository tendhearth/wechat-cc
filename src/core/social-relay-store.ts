/**
 * social-relay-store.ts — the INTERMEDIARY's (介绍人 / W) side of a 2-hop
 * connection. When W forwards a seek and a downstream peer answers yes, W mints
 * a relay_token and persists this row linking the two reveal legs. Both
 * *_revealed_at set ⇒ W declares mutual and crosses the endpoints' identities.
 * Row-driven + durable → survives a W restart (spec #2 reveal relay).
 */
import type { Db } from '../lib/db'

export interface RelayRow {
  id: string; intent_id: string; relay_token: string
  upstream_agent_id: string; downstream_agent_id: string
  upstream_revealed_at: string | null; downstream_revealed_at: string | null
  created_at: string
}
export interface RelayStore {
  /** Persist a relay leg. id = `intent_id:relay_token`. */
  create(r: { id: string; intentId: string; relayToken: string; upstreamAgentId: string; downstreamAgentId: string }): void
  get(id: string): RelayRow | null
  /** Resolve the downstream (Q) leg when a reveal arrives WITHOUT a relay_token. */
  getByIntentDownstream(intentId: string, downstreamAgentId: string): RelayRow | null
  setUpstreamRevealed(id: string, at: string): void
  setDownstreamRevealed(id: string, at: string): void
  list(): RelayRow[]
}

export function makeRelayStore(db: Db): RelayStore {
  const ins = db.query<unknown, [string, string, string, string, string, string]>(
    `INSERT INTO social_relay(id, intent_id, relay_token, upstream_agent_id, downstream_agent_id, upstream_revealed_at, downstream_revealed_at, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`,
  )
  const selOne = db.query<RelayRow, [string]>('SELECT * FROM social_relay WHERE id = ?')
  const selByPair = db.query<RelayRow, [string, string]>(
    'SELECT * FROM social_relay WHERE intent_id = ? AND downstream_agent_id = ? ORDER BY created_at DESC, rowid DESC',
  )
  const selAll = db.query<RelayRow, []>('SELECT * FROM social_relay ORDER BY created_at DESC, rowid DESC')
  const updUp = db.query<unknown, [string, string]>('UPDATE social_relay SET upstream_revealed_at = ? WHERE id = ?')
  const updDown = db.query<unknown, [string, string]>('UPDATE social_relay SET downstream_revealed_at = ? WHERE id = ?')
  return {
    create(r) { ins.run(r.id, r.intentId, r.relayToken, r.upstreamAgentId, r.downstreamAgentId, new Date().toISOString()) },
    get(id) { return selOne.get(id) ?? null },
    getByIntentDownstream(intentId, downstreamAgentId) { return selByPair.get(intentId, downstreamAgentId) ?? null },
    setUpstreamRevealed(id, at) { updUp.run(at, id) },
    setDownstreamRevealed(id, at) { updDown.run(at, id) },
    list() { return selAll.all() },
  }
}
