/**
 * social-relay-store.ts — the INTERMEDIARY's (介绍人 / W) side of a 2-hop
 * connection. When W forwards a seek and a downstream peer answers yes, W mints
 * a relay_token and persists this row linking the two reveal legs. Both
 * *_revealed_at set ⇒ W declares mutual and crosses the endpoints' identities.
 * Row-driven + durable → survives a W restart (spec #2 reveal relay).
 */
import type { Db } from '../lib/db'
import type { PenpalHandle } from './penpal-crypto'

export interface RelayRow {
  id: string; intent_id: string; relay_token: string
  upstream_agent_id: string; downstream_agent_id: string
  upstream_revealed_at: string | null; downstream_revealed_at: string | null
  upstream_handle: string | null; downstream_handle: string | null
  created_at: string
}
export interface RelayStore {
  /** Persist a relay leg. id = `intent_id:relay_token`. */
  create(r: { id: string; intentId: string; relayToken: string; upstreamAgentId: string; downstreamAgentId: string }): void
  get(id: string): RelayRow | null
  /** Resolve the downstream (Q) leg when a reveal arrives WITHOUT a relay_token. */
  getByIntentDownstream(intentId: string, downstreamAgentId: string): RelayRow | null
  /** Content-blind letter routing (Task 9): scan the two stored handle columns
   *  (each a JSON PenpalHandle with a channel_id) to find the relay leg a
   *  given channel_id belongs to. Unknown channel_id → null. */
  getByEndpointChannelId(channelId: string): RelayRow | null
  setUpstreamRevealed(id: string, at: string): void
  setDownstreamRevealed(id: string, at: string): void
  /** Persist the pubkey handle S presented on its leg (JSON.stringify'd). */
  setUpstreamHandle(id: string, handle: PenpalHandle): void
  /** Persist the pubkey handle Q presented on its leg (JSON.stringify'd). */
  setDownstreamHandle(id: string, handle: PenpalHandle): void
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
  const updUpHandle = db.query<unknown, [string, string]>('UPDATE social_relay SET upstream_handle = ? WHERE id = ?')
  const updDownHandle = db.query<unknown, [string, string]>('UPDATE social_relay SET downstream_handle = ? WHERE id = ?')
  return {
    create(r) { ins.run(r.id, r.intentId, r.relayToken, r.upstreamAgentId, r.downstreamAgentId, new Date().toISOString()) },
    get(id) { return selOne.get(id) ?? null },
    getByIntentDownstream(intentId, downstreamAgentId) { return selByPair.get(intentId, downstreamAgentId) ?? null },
    getByEndpointChannelId(channelId) {
      // No dedicated column — the two handles are opaque JSON blobs, so scan
      // in JS rather than risk a SQL substring match false-positiving on the
      // pubkey field. Relay row counts are small; a full scan is fine.
      for (const row of selAll.all()) {
        const up: PenpalHandle | null = row.upstream_handle ? JSON.parse(row.upstream_handle) : null
        const down: PenpalHandle | null = row.downstream_handle ? JSON.parse(row.downstream_handle) : null
        if (up?.channel_id === channelId || down?.channel_id === channelId) return row
      }
      return null
    },
    setUpstreamRevealed(id, at) { updUp.run(at, id) },
    setDownstreamRevealed(id, at) { updDown.run(at, id) },
    setUpstreamHandle(id, handle) { updUpHandle.run(JSON.stringify(handle), id) },
    setDownstreamHandle(id, handle) { updDownHandle.run(JSON.stringify(handle), id) },
    list() { return selAll.all() },
  }
}
