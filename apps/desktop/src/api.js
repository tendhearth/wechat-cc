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

/** @type {Record<'standard'|'operator', { baseUrl: string; token: string } | null>} */
const _cache = { standard: null, operator: null }

/** @type {Record<'standard'|'operator', Promise<{ baseUrl: string; token: string }> | null>} */
const _inflight = { standard: null, operator: null }

/** @param {boolean} operator */
async function getApiCredentials(operator = false) {
  const key = operator ? 'operator' : 'standard'
  if (_cache[key]) return _cache[key]
  if (_inflight[key]) return _inflight[key]
  _inflight[key] = (async () => {
      const r = /** @type {{ ok?: boolean; baseUrl?: string; token?: string; error?: string }} */ (
      await ipcInvoke('wechat_cli_json', { args: ['daemon', 'api-info', '--json', ...(operator ? ['--operator'] : [])] }, undefined)
    )
    if (!r || !r.ok || !r.baseUrl || !r.token) {
      throw new Error(r?.error ?? 'daemon api-info returned no credentials')
    }
    _cache[key] = { baseUrl: r.baseUrl, token: r.token }
    return _cache[key]
  })()
  try {
    return await _inflight[key]
  } finally {
    _inflight[key] = null
  }
}

/**
 * Call a daemon internal-api endpoint.
 * @param {'GET' | 'POST'} method
 * @param {string} path  e.g. '/v1/a2a/list' or '/v1/a2a/activity?agent_id=x&limit=50'
 * @param {Record<string, unknown>} [body]
 * @returns {Promise<unknown>}
 */
export async function invokeApi(method, path, body) {
  return callApi(method, path, body, false)
}

/**
 * Send one internal API request. A daemon restart rotates the local token;
 * retry once with newly read credentials on 401/403 instead of leaving the
 * desktop on a generic failure message.
 * @param {'GET' | 'POST'} method
 * @param {string} path
 * @param {Record<string, unknown> | undefined} body
 * @param {boolean} retried
 * @returns {Promise<unknown>}
 */
async function callApi(method, path, body, retried) {
  // Customer review is intentionally owner-only. It gets the separately
  // scoped operator token; all established desktop surfaces retain their
  // regular token and existing permissions.
  const operator = path.startsWith('/v1/customer-review')
  const { baseUrl, token } = await getApiCredentials(operator)
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
    signal: AbortSignal.timeout(10_000),
  }
  let resp
  try {
    resp = await fetch(url, init)
  } catch (error) {
    // A daemon restart also changes its ephemeral localhost port. The first
    // request can therefore fail before it receives a 401/403 at all; refresh
    // discovery once and retry instead of leaving the feature on a generic
    // “operation failed” state.
    if (!retried) {
      resetApiCredentials()
      return callApi(method, path, body, true)
    }
    throw error
  }
  if (!resp.ok) {
    if (!retried && (resp.status === 401 || resp.status === 403)) {
      resetApiCredentials()
      return callApi(method, path, body, true)
    }
    let errText = `HTTP ${resp.status}`
    try { const j = await resp.json(); errText = j?.error ?? errText } catch { /* ignore */ }
    throw new Error(errText)
  }
  return resp.json()
}

/** Invalidate the cached credentials (e.g. after a daemon restart). */
export function resetApiCredentials() {
  _cache.standard = null
  _cache.operator = null
}
