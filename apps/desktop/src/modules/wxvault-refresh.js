// @ts-check

/** @typedef {{ name?: string, enabled?: boolean, ready?: boolean }} PluginRow */

/** @type {Promise<{ refreshed: boolean, reason?: string }> | null} */
let inFlight = null

/**
 * Refresh an already-configured wxvault archive when the desktop app starts.
 *
 * The setup command is intentionally reused here: once wxvault is ready it
 * skips resign/key capture and only re-decrypts the current WeChat databases.
 * Fresh installs and disabled plugins are left alone, so merely opening the
 * desktop app never launches/closes WeChat as part of first-time setup.
 *
 * Calls are coalesced for the lifetime of the page to avoid two boot paths
 * writing the decrypted SQLite files at the same time.
 *
 * @param {{ invoke: (cmd: string, args: Record<string, unknown>) => Promise<any> }} deps
 */
export function refreshWxvaultOnAppStart(deps) {
  if (inFlight) return inFlight
  inFlight = (async () => {
    // 留在 CLI(架构终态 F6 清点):GET /v1/plugins/list 按设计不列 hidden 插件,wxvault 正是 hidden 的(解密基础设施);
    // 而且接下来的 `plugin setup` 要在 app 的身份下起子进程(完全磁盘访问权限),本来就是装服务 / setup 那一族。
    const rows = /** @type {PluginRow[]} */ (
      await deps.invoke('wechat_cli_json', { args: ['plugin', 'list', '--json'] })
    )
    const wxvault = Array.isArray(rows) ? rows.find(row => row?.name === 'wxvault') : null
    if (!wxvault) return { refreshed: false, reason: 'not-installed' }
    if (!wxvault.enabled) return { refreshed: false, reason: 'disabled' }
    if (!wxvault.ready) return { refreshed: false, reason: 'not-ready' }

    await deps.invoke('wechat_cli_text', { args: ['plugin', 'setup', 'wxvault'] })
    return { refreshed: true }
  })()
  // A FAILED refresh must not be cached. Coalescing exists so two boot paths
  // don't rewrite the decrypted SQLite at once — but keeping the rejected
  // promise meant one transient failure disabled re-decryption for the rest of
  // the page's life, and 待办 / knowledge would then read a stale archive
  // with nothing anywhere saying the data was old.
  inFlight.catch(() => { inFlight = null })
  return inFlight
}

/** Test-only reset for the page-lifetime coalescing guard. */
export function __resetWxvaultRefreshForTests() {
  inFlight = null
}
