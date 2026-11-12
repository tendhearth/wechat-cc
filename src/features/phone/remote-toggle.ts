/**
 * 远程隧道开关的真实读写(agent-config.json 的 remote_tunnel),设置面板的 `remote` 依赖用它。
 * 从 wiring/pipeline-deps 抽出来,好让测试走真实写盘那一路(spec 2026-10-01-tendhearth-pairing-ux §4.1):
 * 只写 remote_tunnel,其余键(尤其 relay_v2_url,主人事项)原样留着。
 */
import { loadAgentConfig } from '../../lib/agent-config'
import { join } from 'node:path'
import { readJsonObject, updateJsonFile, type AtomicWriteOptions } from '../../lib/json-file'

/** Only written after the operator explicitly chooses「连接手机」; never an implicit startup default. */
export const DEFAULT_RELAY_V2_URL = 'wss://relay.tendhearth.com'

/** A single atomic merge preserves unknown/custom settings. Existing nonempty URLs are never replaced. */
export function enablePhoneRelay(stateDir: string, options: AtomicWriteOptions = {}): boolean {
  const path = join(stateDir, 'agent-config.json')
  const raw = readJsonObject(path)
  if (typeof raw.relay_v2_url === 'string' && raw.relay_v2_url.trim() !== '') return false
  let changed = false
  updateJsonFile(path, current => {
    // Re-evaluate on every read/retry: another writer may have just configured its own relay.
    changed = !(typeof current.relay_v2_url === 'string' && current.relay_v2_url.trim() !== '')
    if (!changed) return
    current.relay_v2_url = DEFAULT_RELAY_V2_URL
    current.remote_tunnel = true
  }, { ...options, mode: 0o600 })
  return changed
}

export function makeRemoteToggle(stateDir: string, requestRestart: () => void): {
  isEnabled: () => boolean
  setEnabled: (on: boolean) => void
  requestRestart: () => void
} {
  return {
    isEnabled: () => (loadAgentConfig(stateDir) as { remote_tunnel?: boolean }).remote_tunnel === true,
    setEnabled: (on: boolean) => {
      updateJsonFile(join(stateDir, 'agent-config.json'), raw => { raw.remote_tunnel = on }, { mode: 0o600 })
    },
    requestRestart,
  }
}

/** agent-config.json 的 relay_v2_url 现在非空吗(只读)。 */
export function relayV2Configured(stateDir: string): boolean {
  const v = (loadAgentConfig(stateDir) as { relay_v2_url?: unknown }).relay_v2_url
  return typeof v === 'string' && v.trim() !== ''
}
