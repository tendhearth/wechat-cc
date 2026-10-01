/**
 * 远程隧道开关的真实读写(agent-config.json 的 remote_tunnel),设置面板的 `remote` 依赖用它。
 * 从 wiring/pipeline-deps 抽出来,好让测试走真实写盘那一路(spec 2026-10-01-tendhearth-pairing-ux §4.1):
 * 只写 remote_tunnel,其余键(尤其 relay_v2_url,主人事项)原样留着。
 */
import { loadAgentConfig, saveAgentConfig } from '../lib/agent-config'

export function makeRemoteToggle(stateDir: string, requestRestart: () => void): {
  isEnabled: () => boolean
  setEnabled: (on: boolean) => void
  requestRestart: () => void
} {
  return {
    isEnabled: () => (loadAgentConfig(stateDir) as { remote_tunnel?: boolean }).remote_tunnel === true,
    setEnabled: (on: boolean) => {
      const cur = loadAgentConfig(stateDir)
      saveAgentConfig(stateDir, { ...cur, remote_tunnel: on } as typeof cur)
    },
    requestRestart,
  }
}

/** agent-config.json 的 relay_v2_url 现在非空吗(只读)。 */
export function relayV2Configured(stateDir: string): boolean {
  const v = (loadAgentConfig(stateDir) as { relay_v2_url?: unknown }).relay_v2_url
  return typeof v === 'string' && v.trim() !== ''
}
