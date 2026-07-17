/**
 * wechat-cc social <subcommand> — 觅食台 read surface.
 *
 * Subcommands (read-only; work with the daemon DOWN):
 *   seeks     List my wishes + status (foraging/echoed/connected/closed)
 *   echoes    List postcards that came back (MASKED — see below)
 *   pledges   List wishes of others I answered
 *
 * `reveal` lives in cli.ts — it needs the running daemon (network + notify).
 *
 * PRIVACY: echoes are projected through toPublicEcho() before printing.
 * The raw EchoRow carries peer_agent_id / relay_via / relay_token — server-side
 * only, hidden until a mutual reveal. Printing a raw row would re-open the leak
 * that GET /v1/social/echoes was fixed to close.
 *
 * See docs/superpowers/specs/2026-07-17-cli-social-surface-design.md.
 */
import { openWechatDb } from '../lib/db'
import { makeSeekStore } from '../core/social-seek-store'
import { makeEchoStore, toPublicEcho, type PublicEchoRow } from '../core/social-echo-store'
import { makePledgeStore } from '../core/social-pledge-store'

export interface SocialReadOpts { limit: number; json: boolean }

/**
 * Close the db handle before returning — a leaked SQLite handle blocks the
 * file from being deleted on Windows (EBUSY). Same guard as cmdAgentActivity.
 */
function withDb<T>(stateDir: string, fn: (db: ReturnType<typeof openWechatDb>) => T): T {
  const db = openWechatDb(stateDir)
  try { return fn(db) } finally { db.close() }
}

export function cmdSocialSeeks(stateDir: string, opts: SocialReadOpts): void {
  const rows = withDb(stateDir, db => makeSeekStore(db).list()).slice(0, opts.limit)
  if (opts.json) { console.log(JSON.stringify({ seeks: rows }, null, 2)); return }
  if (rows.length === 0) { console.log('还没有心愿(no seeks)'); return }
  for (const r of rows) {
    console.log(`${r.created_at}  ${r.status.padEnd(9)} ${r.kind}  ${r.topic}  [${r.id}]`)
  }
}

export function cmdSocialEchoes(stateDir: string, opts: SocialReadOpts & { seek?: string }): void {
  const rows: PublicEchoRow[] = withDb(stateDir, db => {
    const store = makeEchoStore(db)
    const raw = opts.seek ? store.listForSeek(opts.seek) : store.listAll()
    // MUST project — never print a raw EchoRow (peer_agent_id/relay_*).
    return raw.map(toPublicEcho)
  }).slice(0, opts.limit)
  if (opts.json) { console.log(JSON.stringify({ echoes: rows }, null, 2)); return }
  if (rows.length === 0) { console.log('还没有回声(no echoes)'); return }
  for (const r of rows) {
    const waiting = r.self_revealed_at && !r.peer_revealed_at ? ' (已揭晓,等对方)' : ''
    console.log(`${r.created_at}  ${r.status.padEnd(8)} 第${r.degree}度  ${r.peer_masked}: ${r.content}${waiting}  [${r.id}]`)
  }
}

export function cmdSocialPledges(stateDir: string, opts: SocialReadOpts): void {
  const rows = withDb(stateDir, db => makePledgeStore(db).list()).slice(0, opts.limit)
  if (opts.json) { console.log(JSON.stringify({ pledges: rows }, null, 2)); return }
  if (rows.length === 0) { console.log('还没有应答(no pledges)'); return }
  for (const r of rows) {
    const both = r.self_revealed_at && r.peer_revealed_at
    const state = both ? 'connected' : r.self_revealed_at ? '已揭晓,等对方' : r.peer_revealed_at ? '对方已揭晓,待你' : 'pending'
    console.log(`${r.created_at}  ${state}  ${r.topic}  [${r.id}]`)
  }
}
