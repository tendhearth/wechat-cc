// QA-only boundaries: synthetic facts; native commands target this test app's CC.
export function createQAApi() {
  let scenario = 'idle'
  const allowed = new Set(['idle', 'working', 'thinking', 'permission', 'away', 'completed'])
  const since = new Date().toISOString()
  let lastDone = null
  return {
    setScenario(value) {
      if (!allowed.has(value)) throw Error('Unknown QA scenario')
      scenario = value
      if (value === 'completed') lastDone = new Date(Date.now()).toISOString()
    },
    /** @returns {Promise<any>} */
    async invokeApi(method, path) {
      if (method !== 'GET') throw Error('Backend request blocked by isolated native QA')
      if (path === '/v1/companion/presence') return {
        presence: scenario === 'away' ? 'down' : 'ok',
        activity: { kind: scenario === 'working' ? 'working' : 'idle', label: '', since: null },
        news: { unread: 0, latest_kind: null, latest_title: null },
      }
      if (path === '/v1/companion/pet') return {
        owner_last_contact_at: null, last_done_at: lastDone,
        turn: { phase: ['thinking', 'working', 'permission'].includes(scenario) ? scenario : 'idle', since },
        pending_permissions: scenario === 'permission' ? [{ hash: 'qa-only', prompt: '演示权限卡，不会执行操作。', since, expires_at: new Date(Date.now() + 3_600_000).toISOString() }] : [],
      }
      throw Error('Backend request blocked by isolated native QA')
    },
  }
}

// Installed only in the staged test webview before preference factories load.
export function createQAClock(now = Date.now) {
  let offset = 0
  return {
    now: () => now() + offset,
    /** @param {unknown} value */
    setOffset(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 4 * 60 * 60_000) throw Error('Invalid QA clock offset')
      offset = value
    },
  }
}

/**
 * @param {{behavior: string}} state
 * @param {boolean} quiet
 * @param {{getAttribute(name: string): string | null, textContent: string | null} | null} control
 */
export function captureQAObservation(state, quiet, control) {
  const quietPressed = control?.getAttribute('aria-pressed') ?? null
  const quietAction = control?.textContent?.trim() ?? null
  return { behavior: state.behavior, quiet, quietPressed, quietAction,
    quietOffApplied: quiet === false && quietPressed === 'false' && quietAction === '安静一小时' }
}

/** @param {(command: string, args: Record<string, unknown>) => Promise<unknown>} nativeInvoke */
export function createQAInvoke(nativeInvoke, clearPermission = () => {}) {
  const controls = new Set(['open_companion_window', 'close_companion_window', 'start_companion_drag', 'resize_companion_window', 'reset_companion_position', 'show_main_window', 'take_pending_navigate'])
  return async (command, args = {}) => {
    if (command === 'pet_permission_resolve') { clearPermission(); return false }
    if (!controls.has(command)) throw Error('Native/backend command blocked by isolated native QA')
    return nativeInvoke(command, args)
  }
}
