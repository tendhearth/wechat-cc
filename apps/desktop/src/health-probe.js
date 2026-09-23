// health-probe.js — thin JS wrapper around the wechat_health_ping Tauri command.
//
// Why this is in Rust (not JS):
//   The bearer token lives in <stateDir>/internal-token at mode 0o600.
//   Reading a 0o600 file from the renderer would require broadening Tauri's
//   `fs` allowlist, which we deliberately avoid. Instead the Rust command
//   reads the file and performs the fetch; the result is a plain bool.
//
// Contract:
//   - NEVER throws — any error (no daemon, no token file, network down,
//     timeout) resolves to `false`.
//   - Returns `true` iff the daemon's /v1/health responds with HTTP 200.

// @ts-check
/// <reference lib="dom" />

// window.__TAURI__ is injected by the Tauri runtime; cast to any to avoid
// needing to import @tauri-apps/api types (same pattern as ipc.js).
/** @type {(command: string, args?: Record<string, unknown>) => Promise<unknown>} */
const invoke = /** @type {any} */ (window).__TAURI__?.core?.invoke
  ?? (() => Promise.reject(new Error('invoke not available')))

/**
 * Ping the daemon's /v1/health endpoint via the Tauri `wechat_health_ping`
 * command. Reads the bearer token from `tokenFilePath` in Rust (0o600 file).
 *
 * @param {number} port            - The daemon's internal HTTP port.
 * @param {string} tokenFilePath   - Absolute path to the internal-token file.
 * @param {number} [timeoutMs=1500] - Request timeout in milliseconds.
 * @returns {Promise<boolean>}     - true if /v1/health returned 200; false on any error.
 */
export async function pingHealth(port, tokenFilePath, timeoutMs = 1500) {
  try {
    const result = await invoke('wechat_health_ping', {
      tokenFilePath,
      port,
      timeoutMs,
    })
    return result === true
  } catch {
    return false
  }
}

/**
 * 读 /v1/health 的 version 段,连同本包自带的 CLI 版本一起返回;任何失败都是 null(诊断不因此报错)。
 * @param {number} port @param {string} tokenFilePath @param {number} [timeoutMs=1500]
 * @returns {Promise<{running:{cli:string|null,head?:string|null,boot_at?:string}|null,expected:string|null}|null>}
 */
export async function fetchDaemonVersion(port, tokenFilePath, timeoutMs = 1500) {
  try {
    const result = await invoke('wechat_health_version', { tokenFilePath, port, timeoutMs })
    return result && typeof result === 'object' ? /** @type {any} */ (result) : null
  } catch {
    return null
  }
}
