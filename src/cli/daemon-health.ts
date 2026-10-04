/**
 * daemon-health — CLI 侧问在跑的 daemon 的 GET /v1/health(本机回环,不出门)。
 *
 * `guard status`(被冻住的任务)和 `wechat-cc status`(开机探测失败、正在重探的
 * provider,2026-10-04)都要这一份。daemon 没在跑 / 读不出 ⇒ null(不是空表 ——
 * 不知道就别说没有)。
 */
import { readFileSync } from 'node:fs'
import { readDaemon } from './doctor'

/** GET /v1/health.provider_probes 的一行(daemon 侧 ProbeRetryStatus 的线上形状)。 */
export interface ProviderProbeRow {
  id: string
  state: 'retrying' | 'registered'
  attempts: number
  last_error: string
  first_failed_at: string
  next_attempt_at: string | null
  registered_at: string | null
}

export async function fetchDaemonHealth(stateDir: string, fetchFn: typeof fetch = fetch): Promise<Record<string, unknown> | null> {
  try {
    const d = readDaemon(stateDir)
    if (!d.alive || !d.internal_api) return null
    const token = readFileSync(d.internal_api.token_file_path, 'utf8').trim()
    const res = await fetchFn(`http://127.0.0.1:${d.internal_api.port}/v1/health`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) })
    if (!res.ok) return null
    return await res.json() as Record<string, unknown>
  } catch { return null }
}

/** health 里取 provider_probes;老 daemon 没这个字段 ⇒ null。 */
export function providerProbesFrom(health: Record<string, unknown> | null): ProviderProbeRow[] | null {
  const v = health?.provider_probes
  return Array.isArray(v) ? v as ProviderProbeRow[] : null
}

/** 人读的几行。没有失败过的探测 ⇒ 一行「都正常」。 */
export function formatProviderProbes(rows: ProviderProbeRow[] | null): string[] {
  if (rows === null) return ['providers: (daemon 没在跑或读不出,不知道开机探测的情况)']
  if (!rows.length) return ['providers: 开机探测都通过了']
  return rows.map(r => r.state === 'retrying'
    ? `providers: ${r.id} 探测失败,重试中(已重探 ${r.attempts} 次${r.next_attempt_at ? `,下次 ${r.next_attempt_at}` : ''})${r.last_error ? ` — ${r.last_error}` : ''}`
    : `providers: ${r.id} 开机探测失败,第 ${r.attempts} 次重探通过,已注册(${r.registered_at ?? '?'})`)
}
