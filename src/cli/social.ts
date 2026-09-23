/**
 * wechat-cc social <subcommand> — 觅食台 surface.
 *
 * `wishes` (cmdSocialWishes, below) lists the owner's own 心愿 (spec
 * 2026-09-04-wish-postcard §4): id / status / sent_to / replies / text.
 * Unlike the deleted read subcommands this goes through the RUNNING
 * daemon's internal-api (GET /v1/social/wishes) rather than reading the db
 * directly — the route already projects the redacted text + effective
 * status, so the CLI never has to duplicate that logic.
 *
 * See docs/superpowers/specs/2026-09-04-wish-postcard-design.md.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonFile } from '../lib/read-json-file'

export interface SocialDaemonDeps {
  fetch?: typeof fetch
  readInfo?: () => { baseUrl: string; tokenFilePath: string } | null
  readToken?: (p: string) => string
  fail?: (msg: string) => never
}

interface DaemonConn { baseUrl: string; token: string; doFetch: typeof fetch; fail: (msg: string) => never }

/** Shared readInfo/readToken/fail scaffold — every social CLI subcommand talks to the running daemon's internal-api the same way. */
function connectDaemon(stateDir: string, deps: SocialDaemonDeps, label: string): DaemonConn {
  const doFetch = deps.fetch ?? fetch
  const fail = deps.fail ?? ((msg: string): never => { console.error(`${label}: ${msg}`); throw new Error(msg) })
  const readInfo = deps.readInfo ?? (() => {
    const p = join(stateDir, 'internal-api-info.json')
    if (!existsSync(p)) return null
    try {
      const parsed = readJsonFile(p) as { baseUrl?: string; tokenFilePath?: string }
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

async function getJson(conn: DaemonConn, path: string): Promise<Response> {
  return conn.doFetch(`${conn.baseUrl}${path}`, {
    method: 'GET',
    headers: { 'authorization': `Bearer ${conn.token}` },
  })
}

export interface WishRow {
  id: string
  text: string
  status: string
  created_at: string
  expires_at: string | null
  sent_to: number
  replies: number
}

/**
 * `wishes` — list the owner's own 心愿 (GET /v1/social/wishes). Needs the
 * RUNNING daemon (same posture as the deleted propose/confirm/cancel/reveal
 * commands): the route already redacts the text and derives the effective
 * status (draft/open/closed/cancelled/expired), so this just prints it.
 */
export async function cmdSocialWishes(
  stateDir: string,
  opts: { json: boolean },
  deps: SocialDaemonDeps = {},
): Promise<void> {
  const conn = connectDaemon(stateDir, deps, 'social wishes')

  let resp: Response
  try { resp = await getJson(conn, '/v1/social/wishes') }
  catch (err) { return void conn.fail(`could not reach the daemon: ${err instanceof Error ? err.message : String(err)}`) }
  if (!resp.ok) conn.fail(`daemon returned ${resp.status}`)

  let body: { wishes: WishRow[] }
  try { body = await resp.json() as { wishes: WishRow[] } }
  catch { return void conn.fail('daemon returned a non-JSON response') }

  if (opts.json) { console.log(JSON.stringify(body, null, 2)); return }
  if (body.wishes.length === 0) { console.log('还没有心愿(no wishes)'); return }
  for (const w of body.wishes) {
    console.log(`${w.id}  ${w.status.padEnd(9)} sent_to=${w.sent_to} replies=${w.replies}  ${w.text}`)
  }
}
