// @ts-check
/// <reference lib="dom" />
/**
 * Thin helper for the dashboard modules that need to call the running
 * daemon's internal HTTP API (/v1/...).
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
 * The customer-review routes are admin-tier, and admin is NOT what this file's
 * cached token carries. The earlier approach — fetch the operator token via
 * `daemon api-info --operator` and use it here — put an admin credential in the
 * renderer's heap, where any script running in the webview could take it and
 * then reach everything in that token's routeAllow, including
 * POST /v1/companion/converse (speak to WeChat as the owner).
 *
 * So the host performs the call instead: `customer_review_api` reads the token
 * in Rust, enforces the /v1/customer-review path prefix, and returns only the
 * response body. The dev server implements the same command (test-shim.ts), so
 * browser dev keeps the token server-side too.
 *
 * Demoting the routes to `trusted` was the other candidate and is unsafe:
 * ordinary chat sessions are minted `trusted`, so anyone talking to the bot
 * would be able to read the owner's private customer judgments.
 * @param {'GET' | 'POST'} method
 * @param {string} path
 * @param {Record<string, unknown>} [body]
 * @returns {Promise<unknown>}
 */
async function callOwnerWorkspace(method, path, body) {
  const raw = /** @type {string} */ (await ipcInvoke('customer_review_api', {
    method,
    path,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }, undefined))
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error(`customer review returned a non-JSON response: ${raw.slice(0, 120)}`)
  }
}

/**
 * Call a daemon internal-api endpoint.
 * @param {'GET' | 'POST'} method
 * @param {string} path  e.g. '/v1/a2a/list' or '/v1/a2a/activity?agent_id=x&limit=50'
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
  // Customer review is intentionally owner-only: the host holds that
  // credential, so the request never runs in this file. See callOwnerWorkspace.
  if (path.startsWith('/v1/customer-review')) return callOwnerWorkspace(method, path, body)
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
    // customer-review records for one click. A timeout is the worst case to
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
    try { const j = await resp.json(); errText = j?.error ?? errText } catch { /* ignore */ }
    throw new Error(errText)
  }
  return resp.json()
}

/** Invalidate the cached credentials (e.g. after a daemon restart). */
export function resetApiCredentials() {
  _cache = null
}
