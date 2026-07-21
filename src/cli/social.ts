/**
 * wechat-cc social <subcommand> — 觅食台 read surface.
 *
 * Subcommands (read-only; work with the daemon DOWN):
 *   seeks     List my wishes + status (foraging/echoed/connected/closed)
 *   echoes    List postcards that came back (MASKED — see below)
 *   pledges   List wishes of others I answered
 *
 * `reveal` (cmdSocialReveal, below) needs the RUNNING daemon (network +
 * notify) — it goes through the internal-api rather than reading the db.
 *
 * PRIVACY: echoes are projected through toPublicEcho() before printing.
 * The raw EchoRow carries peer_agent_id / relay_via / relay_token — server-side
 * only, hidden until a mutual reveal. Printing a raw row would re-open the leak
 * that GET /v1/social/echoes was fixed to close.
 *
 * See docs/superpowers/specs/2026-07-17-cli-social-surface-design.md.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { openWechatDb } from '../lib/db'
import { makeSeekStore } from '../core/social-seek-store'
import { makeEchoStore, toPublicEcho, type PublicEchoRow } from '../core/social-echo-store'
import { makePledgeStore } from '../core/social-pledge-store'
import type { ProposeOutcome, ConfirmOutcome, CancelOutcome } from '../core/social-broker'

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

export interface RevealDeps {
  fetch?: typeof fetch
  readInfo?: () => { baseUrl: string; tokenFilePath: string } | null
  readToken?: (p: string) => string
  fail?: (msg: string) => never
}

/**
 * `reveal` cannot read the db directly: it performs A2A network calls and fires
 * notification beats, so it must go through the RUNNING daemon's internal-api —
 * same pattern as `mode set` in cli.ts. Echo-or-pledge is auto-detected exactly
 * like the WeChat 揭晓 command: try echoes/reveal, fall back on 404.
 */
export async function cmdSocialReveal(
  stateDir: string,
  id: string,
  opts: { json: boolean },
  deps: RevealDeps = {},
): Promise<void> {
  const doFetch = deps.fetch ?? fetch
  const fail = deps.fail ?? ((msg: string): never => { console.error(`social reveal: ${msg}`); throw new Error(msg) })
  const readInfo = deps.readInfo ?? (() => {
    const p = join(stateDir, 'internal-api-info.json')
    if (!existsSync(p)) return null
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf8')) as { baseUrl?: string; tokenFilePath?: string }
      return parsed.baseUrl && parsed.tokenFilePath ? { baseUrl: parsed.baseUrl, tokenFilePath: parsed.tokenFilePath } : null
    } catch { return null }
  })
  const readToken = deps.readToken ?? ((p: string) => readFileSync(p, 'utf8').trim())

  const info = readInfo()
  if (!info) fail('daemon not running (internal-api-info.json missing or malformed — start the daemon first)')

  let token: string
  try { token = readToken(info!.tokenFilePath) }
  catch (err) { return void fail(`could not read token file: ${err instanceof Error ? err.message : String(err)}`) }

  async function post(path: string): Promise<Response> {
    return doFetch(`${info!.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${token}` },
      body: JSON.stringify({ id }),
    })
  }

  let resp: Response
  try { resp = await post('/v1/social/echoes/reveal') }
  catch (err) { return void fail(`could not reach the daemon: ${err instanceof Error ? err.message : String(err)}`) }

  // 404 ⇒ not an echo id; it may be a pledge (a wish of someone else I answered).
  if (resp.status === 404) {
    try { resp = await post('/v1/social/pledges/reveal') }
    catch (err) { return void fail(`could not reach the daemon: ${err instanceof Error ? err.message : String(err)}`) }
    if (resp.status === 404) fail(`没找到「${id}」这条(既不是回声也不是应答,可能已过期或已牵线)`)
  }
  if (!resp.ok) fail(`daemon returned ${resp.status}`)

  let body: { outcome?: { state?: string } }
  try { body = await resp.json() as { outcome?: { state?: string } } }
  catch { return void fail('daemon returned a non-JSON response') }
  const state = body.outcome?.state ?? 'unknown'
  if (opts.json) { console.log(JSON.stringify({ ok: true, id, state })); return }
  const note = state === 'connected' ? '🤝 牵上线了'
    : state === 'awaiting_peer' ? '已揭晓,等对方回揭'
    : state === 'peer_unreachable' ? '揭晓已发出,但对面暂时够不着 — 可稍后重试(你的同意已保存)'
    : state
  console.log(`${state} — ${note}`)
}

// ── P4 派心愿 — propose / confirm / cancel (CLI mirror of the WeChat
// 派 <id> / 取消 <id> commands, see pipeline-deps.ts's dispatch seam and
// seek-command.ts). Same daemon-call posture as `reveal`: these need the
// RUNNING daemon (propose gates via the model, confirm/cancel touch the
// broker), so they go through the internal-api rather than the db. Results
// are unions ({ok:true,...}/{ok:false,reason}) — branch on `.ok`, never
// assume success.

export interface SocialDaemonDeps {
  fetch?: typeof fetch
  readInfo?: () => { baseUrl: string; tokenFilePath: string } | null
  readToken?: (p: string) => string
  fail?: (msg: string) => never
}

interface DaemonConn { baseUrl: string; token: string; doFetch: typeof fetch; fail: (msg: string) => never }

/** Shared readInfo/readToken/fail scaffold — mirrors cmdSocialReveal's inline version. */
function connectDaemon(stateDir: string, deps: SocialDaemonDeps, label: string): DaemonConn {
  const doFetch = deps.fetch ?? fetch
  const fail = deps.fail ?? ((msg: string): never => { console.error(`${label}: ${msg}`); throw new Error(msg) })
  const readInfo = deps.readInfo ?? (() => {
    const p = join(stateDir, 'internal-api-info.json')
    if (!existsSync(p)) return null
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf8')) as { baseUrl?: string; tokenFilePath?: string }
      return parsed.baseUrl && parsed.tokenFilePath ? { baseUrl: parsed.baseUrl, tokenFilePath: parsed.tokenFilePath } : null
    } catch { return null }
  })
  const readToken = deps.readToken ?? ((p: string) => readFileSync(p, 'utf8').trim())

  const info = readInfo()
  if (!info) fail('daemon not running (internal-api-info.json missing or malformed — start the daemon first)')

  let token: string
  try { token = readToken(info!.tokenFilePath) }
  catch (err) { fail(`could not read token file: ${err instanceof Error ? err.message : String(err)}`) }

  return { baseUrl: info!.baseUrl, token: token!, doFetch, fail }
}

async function postJson(conn: DaemonConn, path: string, body: unknown): Promise<Response> {
  return conn.doFetch(`${conn.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${conn.token}` },
    body: JSON.stringify(body),
  })
}

/**
 * 派 <topic> (预览) — gates the topic (+ optional city) and persists a
 * `proposed` row carrying the redacted wording; sends NOTHING yet. Prints
 * the redacted preview WYSIWYG-style (the owner sees exactly what confirm
 * will broadcast) plus the 派/取消 follow-up hint, or the gate-reject reason.
 */
export async function cmdSocialPropose(
  stateDir: string,
  topic: string,
  opts: { city?: string; json: boolean },
  deps: SocialDaemonDeps = {},
): Promise<void> {
  const conn = connectDaemon(stateDir, deps, 'social propose')

  let resp: Response
  try { resp = await postJson(conn, '/v1/social/seek/propose', { topic, ...(opts.city ? { city: opts.city } : {}) }) }
  catch (err) { return void conn.fail(`could not reach the daemon: ${err instanceof Error ? err.message : String(err)}`) }
  if (!resp.ok) conn.fail(`daemon returned ${resp.status}`)

  let body: ProposeOutcome
  try { body = await resp.json() as ProposeOutcome }
  catch { return void conn.fail('daemon returned a non-JSON response') }

  if (opts.json) { console.log(JSON.stringify(body)); return }
  if (!body.ok) { console.log(`没能生成预览 — ${body.reason}`); return }
  const cityPart = body.redacted_city ? `(${body.redacted_city}) ` : ''
  console.log(`心愿预览: ${cityPart}「${body.redacted}」  [${body.intent_id}]`)
  console.log(`微信里回「派 ${body.intent_id}」发出 / 「取消 ${body.intent_id}」作废`)
}

/**
 * 派 <id> — confirm a still-`proposed` row: flips it to foraging and
 * broadcasts the STORED redacted wording verbatim (no re-gate). Success/
 * failure copy mirrors pipeline-deps.ts's WeChat 派 handler exactly.
 */
export async function cmdSocialConfirm(
  stateDir: string,
  id: string,
  opts: { json: boolean },
  deps: SocialDaemonDeps = {},
): Promise<void> {
  const conn = connectDaemon(stateDir, deps, 'social confirm')

  let resp: Response
  try { resp = await postJson(conn, '/v1/social/seek/confirm', { id }) }
  catch (err) { return void conn.fail(`could not reach the daemon: ${err instanceof Error ? err.message : String(err)}`) }
  if (!resp.ok) conn.fail(`daemon returned ${resp.status}`)

  let body: ConfirmOutcome
  try { body = await resp.json() as ConfirmOutcome }
  catch { return void conn.fail('daemon returned a non-JSON response') }

  if (opts.json) { console.log(JSON.stringify(body)); return }
  console.log(body.ok ? '已发出,觅食中…(稍后回来看回声)' : '这条心愿不存在或已处理')
}

/**
 * 取消 <id> — void a still-`proposed` row before it ever goes out.
 * Idempotent server-side (a non-proposed row returns ok without a
 * re-write); success copy mirrors pipeline-deps.ts's WeChat 取消 handler.
 */
export async function cmdSocialCancel(
  stateDir: string,
  id: string,
  opts: { json: boolean },
  deps: SocialDaemonDeps = {},
): Promise<void> {
  const conn = connectDaemon(stateDir, deps, 'social cancel')

  let resp: Response
  try { resp = await postJson(conn, '/v1/social/seek/cancel', { id }) }
  catch (err) { return void conn.fail(`could not reach the daemon: ${err instanceof Error ? err.message : String(err)}`) }
  if (!resp.ok) conn.fail(`daemon returned ${resp.status}`)

  let body: CancelOutcome
  try { body = await resp.json() as CancelOutcome }
  catch { return void conn.fail('daemon returned a non-JSON response') }

  if (opts.json) { console.log(JSON.stringify(body)); return }
  console.log(body.ok ? '已作废' : `没能作废 — ${body.reason}`)
}
