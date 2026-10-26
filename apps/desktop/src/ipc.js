// @ts-check
/// <reference lib="dom" />
// IPC bridge between the Tauri webview and the bundled wechat-cc CLI.
// In production: dispatches through window.__TAURI__.core.invoke (which the
// Rust shim implements via tauri-plugin-shell.sidecar). In dev/test:
// falls back to mockInvoke (browser without Tauri) or apps/desktop/test-shim.ts
// (POST /__invoke that re-dispatches into `bun cli.ts`).

import { mockInvoke } from "./mock.js"

const mock = !(/** @type {any} */ (window).__TAURI__?.core?.invoke)

/**
 * @param {string} command
 * @param {Record<string, any>} [args]
 * @param {any} [state]
 * @returns {Promise<any>}
 */
export async function invoke(command, args = {}, state) {
  if (!mock) return await /** @type {any} */ (window).__TAURI__.core.invoke(command, args)
  return mockInvoke(command, args, state)
}

// Translate raw invoke errors into copy a user can act on. Network/transport
// failures become "无法连接到 wechat-cc CLI"; everything else passes through
// (it's already a string from the Rust shim or test-shim).
/** @param {any} err */
export function formatInvokeError(err) {
  const msg = String(err?.message ?? err ?? "未知错误")
  if (/Failed to fetch|NetworkError|ECONNREFUSED|fetch failed/.test(msg)) {
    return /** @type {any} */ (window).__WECHAT_CC_SHIM__
      ? "无法连接到 wechat-cc CLI（开发 shim 已停止）。"
      : "无法连接到 wechat-cc CLI。请检查 daemon 进程是否运行。"
  }
  return msg
}
