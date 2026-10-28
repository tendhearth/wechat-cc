/**
 * 远程隧道的中继:官方中继 v2(Cloudflare,`apps/relay`,`r…` id)。原生 App 与手机网页都走它。
 *
 * 老 VPS 中继(`t…` id,`/tunnel/*`,`remote_relay_url`)与协议 v1 一起在 2026-10-25 退休(架构终态 F4):
 * 不再连它,也不再生成 `tunnel-id.json`(盘上留着的旧文件不碰)。还指着它的老网页提示「重新扫码配对」。
 *
 * 只在 `remote_tunnel:true` 且显式设了非空 `relay_v2_url` 时才开 —— 缺省值不能把链接指向一个还不存在的域名
 * (上线步骤见 docs/maintainer/relay.md)。身份文件坏了 ⇒ 这次不连(relay-identity.ts 不会悄悄换 id),记一条日志。
 */
import { loadOrCreateRelayIdentity, type RelayIdentity } from './relay-identity'

export interface RemoteRelay {
  identity: RelayIdentity
  daemonUrl: string
  phoneUrl: string
  /** 烤进手机页 / 链接的那份:`{ id: r…, relay: <relay>/v2/phone }`。 */
  remoteInfo: { id: string; relay: string }
}

export function resolveRemoteRelay(
  stateDir: string,
  cfg: { remote_tunnel?: boolean; remote_relay_url?: string; relay_v2_url?: string },
  log: (tag: string, line: string) => void,
): RemoteRelay | null {
  if (cfg.remote_tunnel !== true) return null
  const v2Url = typeof cfg.relay_v2_url === 'string' ? cfg.relay_v2_url.trim() : ''
  if (!v2Url) {
    log('TUNNEL', `remote tunnel is on but relay_v2_url is not set — remote off this boot (the legacy relay${cfg.remote_relay_url ? ` ${cfg.remote_relay_url}` : ''} retired with protocol v1)`)
    return null
  }
  try {
    const base = v2Url.replace(/\/+$/, '')
    const identity = loadOrCreateRelayIdentity(stateDir)
    const phoneUrl = `${base}/v2/phone`
    return { identity, daemonUrl: `${base}/v2/daemon`, phoneUrl, remoteInfo: { id: identity.id, relay: phoneUrl } }
  } catch (e) {
    log('TUNNEL', `relay v2 disabled this boot: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}
