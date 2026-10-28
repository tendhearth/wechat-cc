/**
 * `agent-config.json` 的 `cli_auto_upgrade` 段 → 引擎用的确定值。
 *
 * ```jsonc
 * "cli_auto_upgrade": {
 *   "enabled": true,          // 缺省 true(主人 2026-10-04:默认开,人会忘)
 *   "check_hour": 4,          // 每天本地几点之后做那一次定时检查(0–23,缺省 4)
 *   "per_cli": { "agy": { "enabled": false } }   // 逐个关
 * }
 * ```
 * 关掉只停「自动」:`wechat-cc cli upgrade <name>` 手动照样能用。
 */
import { CLI_IDS, type CliId } from './specs'

export interface ResolvedCliUpgradeConfig {
  enabled: boolean
  checkHour: number
  cli: Record<CliId, boolean>
}

export const DEFAULT_CHECK_HOUR = 4

export function resolveCliUpgradeConfig(raw: unknown): ResolvedCliUpgradeConfig {
  const o = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  const enabled = typeof o.enabled === 'boolean' ? o.enabled : true
  const h = o.check_hour
  const checkHour = typeof h === 'number' && Number.isInteger(h) && h >= 0 && h <= 23 ? h : DEFAULT_CHECK_HOUR
  const per = (o.per_cli && typeof o.per_cli === 'object' && !Array.isArray(o.per_cli) ? o.per_cli : {}) as Record<string, unknown>
  const cli = {} as Record<CliId, boolean>
  for (const id of CLI_IDS) {
    const e = per[id]
    cli[id] = e && typeof e === 'object' && typeof (e as { enabled?: unknown }).enabled === 'boolean'
      ? (e as { enabled: boolean }).enabled
      : true
  }
  return { enabled, checkHour, cli }
}
