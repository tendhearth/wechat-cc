/**
 * Guard config — persisted toggle + probe URL. Runtime state (current
 * IP, last reachable result, last probe timestamp) is kept in-memory by
 * the scheduler — no point persisting it; daemon restart re-probes.
 */
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { readJsonFile } from '../../lib/read-json-file'

export interface GuardConfig {
  enabled: boolean
  probe_url: string
  ipify_url: string
  /**
   * 网络信号从哪来(守护 v2)。'auto'(缺省):装了 bx 只认 bx,没装用 google 探测。
   * 'probe':装了 bx 也改用探测 —— 给「装着 bx、实际在用别的 VPN」的情形。
   */
  signal_source: 'auto' | 'probe'
  /** 一定要保护的调用:host / `provider:模型通配` / 裸 provider id(见 lib/call-classifier.ts)。 */
  protect: string[]
  /** 不需要保护的调用(覆盖默认分类)。protect 压过 trust。 */
  trust: string[]
  /** 自定义网关(非官方、非国内、非自建的 base URL)是否也要保护。缺省 false。 */
  protect_custom_gateways: boolean
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map(x => x.trim()) : []
}

export function defaultGuardConfig(): GuardConfig {
  return {
    enabled: false,
    // Google's /generate_204 — designed for captive-portal/connectivity
    // checks, returns 204 with empty body. No CDN dance, no auth, no logs.
    probe_url: 'https://www.google.com/generate_204',
    ipify_url: 'https://api.ipify.org',
    signal_source: 'auto',
    protect: [],
    trust: [],
    protect_custom_gateways: false,
  }
}

function configPath(stateDir: string): string {
  return join(stateDir, 'guard.json')
}

export function loadGuardConfig(stateDir: string): GuardConfig {
  const p = configPath(stateDir)
  if (!existsSync(p)) return defaultGuardConfig()
  try {
    const raw = readJsonFile(p) as Partial<GuardConfig>
    const d = defaultGuardConfig()
    return {
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : d.enabled,
      probe_url: typeof raw.probe_url === 'string' ? raw.probe_url : d.probe_url,
      ipify_url: typeof raw.ipify_url === 'string' ? raw.ipify_url : d.ipify_url,
      signal_source: raw.signal_source === 'probe' ? 'probe' : 'auto',
      protect: stringList(raw.protect),
      trust: stringList(raw.trust),
      protect_custom_gateways: raw.protect_custom_gateways === true,
    }
  } catch {
    return defaultGuardConfig()
  }
}

export function saveGuardConfig(stateDir: string, cfg: GuardConfig): void {
  const p = configPath(stateDir)
  mkdirSync(dirname(p), { recursive: true })
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 })
  renameSync(tmp, p)
}
