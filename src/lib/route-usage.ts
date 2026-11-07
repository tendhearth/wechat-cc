/** P3h: daily aggregate only; no device IDs, tokens, URLs, bodies or query strings. */
import { rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonFile } from './read-json-file'
import { writeFileAtomic } from './json-file'
import { WIRE_ROUTE_ALIASES, type WireRouteAlias, type RouteRetirement } from '../../packages/protocol/src/wire-compat'

const DAY = 86_400_000
export const ROUTE_USAGE_FILE = 'route-usage.json'
export type RouteClient = RouteRetirement['client']
export interface RouteUsageRow { day: string; client: RouteClient; version: string; alias: string; count: number }
export interface RouteUsage { since: number; rows: RouteUsageRow[] }
const aliases = new Set(WIRE_ROUTE_ALIASES.map(r => r.from))
const clients = new Set(['app', 'web', 'desktop', 'selftest'])
export function readRouteUsage(stateDir: string): RouteUsage | null {
  try {
    const v = readJsonFile<RouteUsage>(join(stateDir, ROUTE_USAGE_FILE))
    if (!Number.isFinite(v.since) || !Array.isArray(v.rows) || v.rows.some(r =>
      !/^\d{4}-\d{2}-\d{2}$/.test(r.day) || !Number.isFinite(Date.parse(r.day)) || !clients.has(r.client) ||
      typeof r.version !== 'string' || r.version.length > 64 || typeof r.alias !== 'string' ||
      !Number.isSafeInteger(r.count) || r.count < 1)) return null
    return v
  } catch { return null }
}
/** Fresh read on every update: the panel and internal API share this file in one daemon. */
/** Retirement only needs presence per day; counts are display-only (a lower bound), so increments flush at most once a minute. */
export const ROUTE_USAGE_COUNT_FLUSH_MS = 60_000
export function makeRouteUsage(stateDir: string, now = Date.now) {
  // Rows already on disk this process; a repeat inside the flush window skips the file entirely (hot request path).
  const persisted = new Set<string>()
  let lastWrite = -Infinity, lastStamp = ''
  const stamp = () => { try { const st = statSync(join(stateDir, ROUTE_USAGE_FILE)); return `${st.mtimeMs}:${st.size}` } catch { return 'missing' } }
  return (client: RouteClient, version?: string | null, key = ''): void => {
    try {
      const matched = aliases.has(key) ? key : [...aliases].find(alias => alias.endsWith('/') && key.startsWith(alias))
      // Page navigation/pairing has no API version headers, even in the new webpage.
      if (key && !matched && !key.includes(' /v1/')) return
      const at = now()
      const rowKeys = ['', ...(matched ? [matched] : [])].map(a => `${new Date(at).toISOString().slice(0, 10)}|${client}|${version ?? ''}|${a}`)
      // stat is the cheap guard: if the file was replaced or broken since our write, fall through and rebuild it.
      if (rowKeys.every(k => persisted.has(k)) && at - lastWrite < ROUTE_USAGE_COUNT_FLUSH_MS && stamp() === lastStamp) return
      const data = readRouteUsage(stateDir) ?? { since: at, rows: [] }
      const day = new Date(at).toISOString().slice(0, 10)
      const cutoff = new Date(at - 30 * DAY).toISOString().slice(0, 10)
      data.rows = data.rows.filter(r => r.day >= cutoff && r.day <= day)
      const cleanVersion = version && /^[A-Za-z0-9.+_-]{1,64}$/.test(version) ? version : 'unknown'
      // An empty alias row is activity, including requests on the new keys.
      let changed = false
      for (const alias of ['', ...(matched ? [matched] : [])]) {
        const row = data.rows.find(r => r.day === day && r.client === client && r.version === cleanVersion && r.alias === alias)
        if (row && alias) { row.count++; changed = true }
        else if (!row) { data.rows.push({ day, client, version: cleanVersion, alias, count: 1 }); changed = true }
      }
      if (!changed) return
      writeFileAtomic(join(stateDir, ROUTE_USAGE_FILE), JSON.stringify(data), { mode: 0o600 })
      lastWrite = at; lastStamp = stamp()
      for (const k of rowKeys) persisted.add(k)
    } catch {
      // A lost counter must invalidate the observation window, not certify zero calls.
      try { rmSync(join(stateDir, ROUTE_USAGE_FILE), { force: true }) } catch { /* telemetry only */ }
    }
  }
}

function meets(version: string, condition: RouteRetirement): boolean {
  if (!condition.minimum || version === 'unknown') return false
  if (condition.client === 'web' || condition.client === 'selftest') return version === condition.minimum
  if (condition.client === 'app') return /^\d+$/.test(version) && BigInt(version) >= BigInt(condition.minimum)
  const a = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  const b = /^(\d+)\.(\d+)\.(\d+)$/.exec(condition.minimum)
  if (!a || !b) return false
  for (let i = 1; i <= 3; i++) {
    if (BigInt(a[i]!) !== BigInt(b[i]!)) return BigInt(a[i]!) > BigInt(b[i]!)
  }
  return true
}
export function retireCheck(data: RouteUsage | null, now = Date.now(), rows: readonly WireRouteAlias[] = WIRE_ROUTE_ALIASES) {
  // Whole UTC buckets, conservatively include the boundary day.
  const cutoff = new Date(now - 30 * DAY).toISOString().slice(0, 10)
  const today = new Date(now).toISOString().slice(0, 10)
  const recent = data?.rows.filter(r => r.day >= cutoff && r.day <= today) ?? []
  return rows.map(row => {
    const reasons: string[] = []
    if (!data || data.since > now - 30 * DAY) reasons.push('观测不足 30 天或记录不可读')
    const usage = recent.filter(r => r.alias === row.from)
    if (usage.length) reasons.push('近 30 天仍有别名调用: ' + usage.map(r => `${r.client}/${r.version} ${r.day} ×${r.count}`).join(', '))
    if (!row.retirement.length) reasons.push('缺少退休条件')
    for (const condition of row.retirement) {
      if (!condition.minimum) reasons.push(`${condition.client}: ${condition.milestone} 退休版本尚未发布/登记`)
      const active = [...new Set(recent.filter(r => r.client === condition.client).map(r => r.version))]
      for (const version of active) if (!meets(version, condition)) reasons.push(`${condition.client}/${version} 未达到 ${condition.minimum ?? condition.milestone}`)
    }
    return { alias: row.from, target: row.to, eligible: reasons.length === 0, reasons }
  })
}
export function formatRetireCheck(result: ReturnType<typeof retireCheck>): string {
  return result.map(r => `${r.eligible ? '可删' : '保留'} ${r.alias} → ${r.target}${r.reasons.length ? '\n  ' + r.reasons.join('\n  ') : '\n  近 30 天无调用，所有活跃客户端均已达到退休版本'}`).join('\n')
}
