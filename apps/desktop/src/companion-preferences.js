// @ts-check
// Window-local motion preferences. Stored deadlines never extend beyond one hour.
export const MOTION_STORAGE_KEY = 'cc.companion.motion.v1'
export const QUIET_MS = 60 * 60_000
/** @typedef {{ userReduced: boolean, systemReduced: boolean, reducedMotion: boolean, quiet: boolean, quietUntil: number }} MotionPreferences */

/** @param {{ storage?: Pick<Storage, 'getItem' | 'setItem'> | null, now?: () => number, monotonicNow?: () => number, systemReduced?: boolean, schedule?: (fn: () => void, ms: number) => unknown, cancel?: (h: unknown) => void, onChange?: (s: MotionPreferences) => void }} [deps] */
export function createCompanionPreferences(deps = {}) {
  const now = deps.now ?? Date.now
  const monotonicNow = deps.monotonicNow ?? (() => performance.now())
  const schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms))
  const cancel = deps.cancel ?? (h => clearTimeout(/** @type {any} */ (h)))
  let destroyed = false
  let userReduced = false
  let systemReduced = deps.systemReduced === true
  /** @type {number | null} */ let quietDeadline = null
  /** @type {number | null} */ let quietWallDeadline = null
  /** @type {unknown} */ let timer = null
  try {
    const value = JSON.parse(deps.storage?.getItem(MOTION_STORAGE_KEY) ?? 'null')
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      userReduced = value.userReduced === true
      const wallNow = now()
      if (Number.isFinite(value.quietUntil) && value.quietUntil > wallNow && value.quietUntil <= wallNow + QUIET_MS) {
        quietWallDeadline = value.quietUntil
        quietDeadline = monotonicNow() + (value.quietUntil - wallNow)
      }
    }
  } catch { /* Unavailable or invalid storage should never disable the companion. */ }
  // WebKit's monotonic clock can pause during machine sleep. Either deadline
  // may end quiet: wall time covers sleep, elapsed time bounds clock rollback.
  // A forward wall adjustment intentionally may end quiet early.
  const remaining = () => {
    if (quietDeadline === null || quietWallDeadline === null) return 0
    return Math.max(0, Math.min(QUIET_MS, quietDeadline - monotonicNow(), quietWallDeadline - now()))
  }
  /** @returns {MotionPreferences} */
  const snapshot = () => {
    const left = remaining()
    return { userReduced, systemReduced, reducedMotion: userReduced || systemReduced, quiet: left > 0, quietUntil: left > 0 ? now() + left : 0 }
  }
  const save = () => { try { deps.storage?.setItem(MOTION_STORAGE_KEY, JSON.stringify({ userReduced, quietUntil: snapshot().quietUntil })) } catch { /* memory-only controls */ } }
  const notify = () => deps.onChange?.(snapshot())
  const arm = () => {
    if (destroyed) return
    if (timer !== null) { cancel(timer); timer = null }
    const left = remaining()
    if (left > 0) timer = schedule(() => { timer = null; refresh() }, left)
  }
  const refresh = () => {
    if (destroyed) return
    if (quietDeadline !== null && remaining() === 0) { quietDeadline = null; quietWallDeadline = null; save(); notify() }
    arm()
  }
  arm()
  return {
    snapshot,
    refresh,
    /** @param {boolean} on */
    setSystemReduced(on) { systemReduced = on === true; notify() },
    /** @param {boolean} on */
    setUserReduced(on) { userReduced = on === true; save(); notify() },
    /** @param {boolean} on */
    setQuiet(on) { quietDeadline = on ? monotonicNow() + QUIET_MS : null; quietWallDeadline = on ? now() + QUIET_MS : null; save(); arm(); notify() },
    destroy() { destroyed = true; if (timer !== null) { cancel(timer); timer = null } },
  }
}
