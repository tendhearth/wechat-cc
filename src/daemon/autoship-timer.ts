import type { AutoshipConfig } from '../lib/autoship-config'

const MINUTE_MS = 60_000
const DEFAULT_INTERVAL_MIN = 20
const MIN_INTERVAL_MIN = 5

/** 挂在 daemon 生命周期的每分钟 tick 上，配置修改无需重启。 */
export function makeAutoshipTick(deps: {
  now: () => number
  settings: () => AutoshipConfig | undefined
  start: () => (() => boolean) | undefined
}): () => void {
  let lastStart = deps.now()
  let childAlive: (() => boolean) | undefined
  return () => {
    const settings = deps.settings()
    if (settings?.auto_ship !== true) return
    const configured = settings.auto_ship_interval_min ?? DEFAULT_INTERVAL_MIN
    const minutes = Math.max(MIN_INTERVAL_MIN, Number.isFinite(configured) ? configured : DEFAULT_INTERVAL_MIN)
    const now = deps.now()
    if (now - lastStart < minutes * MINUTE_MS) return
    if (childAlive?.()) return
    lastStart = now
    childAlive = deps.start()
  }
}
