/**
 * pair.ts — `wechat-cc pair [code]` (spec §7). Both forms call the RUNNING
 * daemon over internal-api (127.0.0.1 + file token, tier trusted): no args →
 * POST /v1/pair/start (prints the code); <code> → POST /v1/pair/accept.
 *
 * The routes pass the engine's PairStartResult/PairResult through VERBATIM —
 * including `ok:false` — at HTTP 200 (see routes-pair.ts). Both bodies here
 * are branched on `.ok`/`.reason`, NOT assumed to be the flattened success
 * shape: a bare `{code, expiresAt}` read would silently swallow start()'s own
 * `relay_drop_failed` failure (see src/core/pairing.ts's PairStartResult).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PairStartResult, PairResult } from '../core/pairing'

interface PairDeps {
  fetch?: typeof fetch
  readInfo?: () => { baseUrl: string; tokenFilePath: string } | null
  readToken?: (p: string) => string
  fail?: (msg: string) => never
}

function resolve(stateDir: string, deps: PairDeps) {
  const fail = deps.fail ?? ((msg: string): never => { console.error(`pair: ${msg}`); throw new Error(msg) })
  const readInfo = deps.readInfo ?? (() => {
    const p = join(stateDir, 'internal-api-info.json')
    if (!existsSync(p)) return null
    try {
      const j = JSON.parse(readFileSync(p, 'utf8')) as { baseUrl?: string; tokenFilePath?: string }
      return j.baseUrl && j.tokenFilePath ? { baseUrl: j.baseUrl, tokenFilePath: j.tokenFilePath } : null
    } catch { return null }
  })
  const readToken = deps.readToken ?? ((p: string) => readFileSync(p, 'utf8').trim())
  const info = readInfo()
  if (!info) fail('daemon not running (internal-api-info.json missing or malformed — start the daemon first)')
  let token: string
  try { token = readToken(info!.tokenFilePath) }
  catch (err) { return fail(`could not read token file: ${err instanceof Error ? err.message : String(err)}`) }
  const doFetch = deps.fetch ?? fetch
  const post = (path: string, body: unknown) => doFetch(`${info!.baseUrl}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  })
  return { post, fail }
}

export async function cmdPairStart(stateDir: string, opts: { json: boolean }, deps: PairDeps = {}): Promise<void> {
  const { post, fail } = resolve(stateDir, deps)
  let resp: Response
  try { resp = await post('/v1/pair/start', {}) } catch (e) { return void fail(`could not reach the daemon: ${e instanceof Error ? e.message : String(e)}`) }
  if (resp.status === 503) fail('pairing not available — configure mailbox_relays first')
  if (!resp.ok) fail(`daemon returned ${resp.status}`)
  let body: PairStartResult
  try { body = await resp.json() as PairStartResult }
  catch { return void fail('daemon returned a non-JSON response') }
  if (opts.json) { console.log(JSON.stringify(body)); return }
  if (!body.ok) {
    // Only failure reason start() can return today; keep the fallback for
    // forward-compat with any new reason the engine might add later.
    console.log(body.reason === 'relay_drop_failed'
      ? '中继暂时够不着,配对码没能生成——稍后再试'
      : `配对码生成失败(${body.reason})`)
    return
  }
  console.log(`配对码 ${body.code} — 发给朋友,10 分钟内有效`)
}

export async function cmdPairAccept(stateDir: string, code: string, opts: { json: boolean }, deps: PairDeps = {}): Promise<void> {
  const { post, fail } = resolve(stateDir, deps)
  if (!/^\d{6}$/.test(code)) fail('code must be 6 digits')
  let resp: Response
  try { resp = await post('/v1/pair/accept', { code }) } catch (e) { return void fail(`could not reach the daemon: ${e instanceof Error ? e.message : String(e)}`) }
  if (resp.status === 503) fail('pairing not available — configure mailbox_relays first')
  if (!resp.ok) fail(`daemon returned ${resp.status}`)
  let body: PairResult
  try { body = await resp.json() as PairResult }
  catch { return void fail('daemon returned a non-JSON response') }
  if (opts.json) { console.log(JSON.stringify(body)); return }
  console.log(body.ok ? `和 ${body.peer.name} 的 bot 连上了 ✓ 现在可以互相觅食/写信了`
    : body.reason === 'self_pair' ? '这是你自己的码,换个朋友的码试试'
    : body.reason === 'id_conflict' ? '对方 bot 使用旧版共享身份且与你已有的朋友撞名——请让对方升级出唯一身份后重试'
    : body.reason === 'relay_drop_failed' ? '名片没能投到中继,配对没完成——请重试'
    : '码不对或已过期,让朋友重新生成一个')
}
