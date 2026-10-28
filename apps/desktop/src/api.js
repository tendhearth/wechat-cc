// @ts-check
/// <reference lib="dom" />
/**
 * Thin helper for the dashboard modules that need to call the running
 * daemon's internal HTTP API (the /v1 routes; paths come from ./daemon-client.js).
 *
 * Bootstrap: calls `wechat-cc daemon api-info --json` (via Tauri IPC /
 * shim) once to get the bound port + bearer token, then reuses those for
 * all subsequent fetch() calls.  The cache is intentionally session-scoped
 * (page lifetime): a daemon restart rotates the token, but the operator
 * will typically reload the dashboard by then anyway.
 *
 * The single exported function is:
 *   invokeApi(method, path, body?) → Promise<unknown>
 *
 * Throws on HTTP ≥400 or network error; callers can catch and alert.
 */

import { invoke as ipcInvoke } from './ipc.js'
import { OWNER_WORKSPACE_PATHS as GENERATED_OWNER_WORKSPACE_PATHS } from './generated/daemon-calls.js'

/** @type {{ baseUrl: string; token: string } | null} */
let _cache = null

/** @type {Promise<{ baseUrl: string; token: string }> | null} */
let _inflight = null

async function getApiCredentials() {
  if (_cache) return _cache
  if (_inflight) return _inflight
  _inflight = (async () => {
    const r = /** @type {{ ok?: boolean; baseUrl?: string; token?: string; error?: string }} */ (
      await ipcInvoke('wechat_cli_json', { args: ['daemon', 'api-info', '--json'] }, undefined)
    )
    if (!r || !r.ok || !r.baseUrl || !r.token) {
      throw new Error(r?.error ?? 'daemon api-info returned no credentials')
    }
    _cache = { baseUrl: r.baseUrl, token: r.token }
    return _cache
  })()
  try {
    return await _inflight
  } finally {
    _inflight = null
  }
}

/**
 * Owner-only workspaces never see their credential.
 *
 * The owner-workspace routes are admin-tier, and admin is NOT what this file's
 * cached token carries. The earlier approach — fetch the operator token via
 * `daemon api-info --operator` and use it here — put an admin credential in the
 * renderer's heap, where any script running in the webview could take it and
 * then reach everything in that token's routeAllow, including
 * POST /v1/companion/converse (speak to WeChat as the owner).
 *
 * So the host performs the call instead: `daemon_request` (架构终态 F5 起和工作台
 * 共用一个宿主命令;以前叫 customer_review_api) reads the token in Rust, enforces
 * an exact route allowlist (the generated route table), and returns only the
 * response body. The dev server implements the same command (test-shim.ts),
 * so browser dev keeps the token server-side too.
 *
 * Demoting the routes to `trusted` was the other candidate and is unsafe:
 * ordinary chat sessions are minted `trusted`, so anyone talking to the bot
 * would be able to read the owner's private obligations and thoughts.
 * @param {'GET' | 'POST'} method
 * @param {string} path
 * @param {Record<string, unknown>} [body]
 * @returns {Promise<unknown>}
 */
/**
 * 交给宿主的那几条 = 路由表 packages/protocol/src/routes.ts 里 `desktop.ownerWorkspace` 的行。`bun run gen:routes`
 * 同时写给 lib.rs(src-tauri/generated/workbench-routes.json)和这里(./generated/daemon-calls.js),两份同源。
 */
export const OWNER_WORKSPACE_PATHS = /** @type {ReadonlySet<string>} */ (new Set(GENERATED_OWNER_WORKSPACE_PATHS))

/** @param {'GET' | 'POST'} method @param {string} path @param {Record<string, unknown>} [body] */
async function callOwnerWorkspace(method, path, body) {
  const raw = /** @type {string} */ (await ipcInvoke('daemon_request', {
    method,
    path,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }, undefined))
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error(`owner workspace returned a non-JSON response: ${raw.slice(0, 120)}`)
  }
}

/**
 * daemon 拒写配置文件(3e,lib/json-file):文件读不出来、或者刚被别处改过。任何一条路由都可能碰上,所以在这里统一
 * 翻成主人看得懂的一句,`code` 留着原码。detail 里是 daemon 给的原因(含文件路径),原样带上,方便主人去看是哪个文件。
 * 其余的码照旧:Error.message 就是码,各处按码判断的代码不受影响。
 * @param {string} code @param {unknown} detail @returns {string | null}
 */
export function configRefusalText(code, detail) {
  const why = typeof detail === 'string' && detail ? `(${detail})` : ''
  if (code === 'config_unreadable') return `配置文件好像坏了,CC 没敢改它${why}`
  if (code === 'config_busy') return '配置文件刚被别处改过,这次没写进去,再试一次'
  return null
}

/**
 * Call a daemon internal-api endpoint.
 * @param {'GET' | 'POST'} method
 * @param {string} path  built by ./daemon-client.js (`v1(invokeApi, V1.a2a.list)`), query string included
 * @param {Record<string, unknown>} [body]
 * @param {{ timeoutMs?: number }} [opts]  timeoutMs overrides the 10s default —
 *   for routes that do model work inline (seek propose runs the grounded
 *   judge, ~15s cold).
 * @returns {Promise<unknown>}
 */
export async function invokeApi(method, path, body, opts) {
  return callApi(method, path, body, false, opts)
}

/**
 * Workbench admin calls always stay in the native host. The renderer receives
 * response JSON, never the operator credential.
 * @param {'GET' | 'POST'} method
 * @param {string} path
 * @param {Record<string, unknown>} [body]
 */
export async function invokeWorkbenchApi(method, path, body) {
  const raw = /** @type {string} */ (await ipcInvoke('daemon_request', {
    method,
    path,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }, undefined))
  if (typeof raw !== 'string') return raw
  try { return JSON.parse(raw) }
  catch { throw new Error(`workbench returned a non-JSON response: ${raw.slice(0, 120)}`) }
}

/**
 * Send one internal API request. A daemon restart rotates the local token;
 * retry once with newly read credentials on 401/403 instead of leaving the
 * desktop on a generic failure message.
 * @param {'GET' | 'POST'} method
 * @param {string} path
 * @param {Record<string, unknown> | undefined} body
 * @param {boolean} retried
 * @param {{ timeoutMs?: number } | undefined} opts
 * @returns {Promise<unknown>}
 */
async function callApi(method, path, body, retried, opts) {
  // Owner-only workspace routes: the host holds the admin credential, so
  // these requests never run in this file. See callOwnerWorkspace. The 待办
  // routes (obligation read/write, contact names, reminder scheduling) are
  // the owner's private data.
  if (OWNER_WORKSPACE_PATHS.has(path.split('?')[0] ?? path)) {
    return callOwnerWorkspace(method, path, body)
  }
  const { baseUrl, token } = await getApiCredentials()
  const url = baseUrl + path
  /** @type {RequestInit} */
  const init = {
    method,
    headers: {
      'authorization': `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    // Bound the request so a blocked/unreachable daemon surfaces as an error
    // instead of an indefinite "加载中…" spinner (e.g. a CSP connect-src gap).
    signal: AbortSignal.timeout(opts?.timeoutMs ?? 10_000),
  }
  let resp
  try {
    resp = await fetch(url, init)
  } catch (error) {
    // A daemon restart also changes its ephemeral localhost port. The first
    // request can therefore fail before it receives a 401/403 at all; refresh
    // discovery once and retry instead of leaving the feature on a generic
    // “operation failed” state.
    //
    // GET ONLY, AND NEVER AFTER AN ABORT. A transport rejection does not tell
    // us whether the daemon already received and acted on the request, so
    // replaying a POST can duplicate its effect — and this is shared code, so
    // it would do that to every surface: a second 60s memory synthesize, the
    // grounded judge run twice, the SAME pen-pal letter delivered twice, two
    // reminders scheduled for one click. A timeout is the worst case to
    // replay, because the daemon is most likely still working on the first
    // one. The 401/403 path below stays for both methods: that is a response,
    // and it proves the daemon refused rather than acted.
    const name = /** @type {{ name?: string } | undefined} */ (error)?.name
    const aborted = name === 'AbortError' || name === 'TimeoutError'
    if (!retried && method === 'GET' && !aborted) {
      resetApiCredentials()
      return callApi(method, path, body, true, opts)
    }
    throw error
  }
  if (!resp.ok) {
    if (!retried && (resp.status === 401 || resp.status === 403)) {
      resetApiCredentials()
      return callApi(method, path, body, true, opts)
    }
    let errText = `HTTP ${resp.status}`
    /** @type {unknown} */
    let detail
    try { const j = await resp.json(); errText = j?.error ?? errText; detail = j?.detail } catch { /* ignore */ }
    const friendly = configRefusalText(errText, detail)
    if (friendly) throw Object.assign(new Error(friendly), { code: errText })
    throw new Error(errText)
  }
  return resp.json()
}

/** Invalidate the cached credentials (e.g. after a daemon restart). */
export function resetApiCredentials() {
  _cache = null
}
