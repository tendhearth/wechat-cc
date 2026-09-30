/**
 * 远程隧道的两条中继(spec 2026-09-30 §8 过渡):老 VPS 中继(`t…` id,已配对的手机网页)
 * + 官方中继 v2(`r…` id,新配对与 app)。过渡期两边都连;新生成的链接指向 v2。
 * v2 只在显式设了 `relay_v2_url`(非空)时才开 —— 生产中继没上线前,缺省值不能把新链接指向一个
 * 还不存在的域名;只设 `remote_relay_url` 的自建者同样只走老中继。上线步骤见 docs/maintainer/relay.md。
 * 身份文件坏了 ⇒ 这次只连老中继(relay-identity.ts 不会悄悄换 id)。
 */
import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonFile } from '../lib/read-json-file'
import { loadOrCreateRelayIdentity, type RelayIdentity } from './relay-identity'

const LEGACY_PHONE_URL = 'wss://cc.tendhearth.com/tunnel/phone'

export interface RemoteRelays {
  legacy: { id: string; daemonUrl: string; phoneUrl: string }
  v2: { identity: RelayIdentity; daemonUrl: string; phoneUrl: string } | null
  remoteInfo: { id: string; relay: string }
}

export function resolveRemoteRelays(
  stateDir: string,
  cfg: { remote_tunnel?: boolean; remote_relay_url?: string; relay_v2_url?: string },
  log: (tag: string, line: string) => void,
): RemoteRelays | null {
  if (cfg.remote_tunnel !== true) return null
  const idPath = join(stateDir, 'tunnel-id.json')
  let did: string
  try { did = (readJsonFile(idPath) as { id: string }).id }
  catch { did = 't' + randomBytes(18).toString('hex'); try { writeFileSync(idPath, JSON.stringify({ id: did }), { mode: 0o600 }) } catch { /* best effort */ } }
  const phoneUrl = cfg.remote_relay_url ?? LEGACY_PHONE_URL
  const legacy = { id: did, phoneUrl, daemonUrl: phoneUrl.replace('/tunnel/phone', '/tunnel/daemon') }

  let v2: RemoteRelays['v2'] = null
  const v2Url = typeof cfg.relay_v2_url === 'string' ? cfg.relay_v2_url.trim() : ''
  if (v2Url) {
    try {
      const base = v2Url.replace(/\/+$/, '')
      v2 = { identity: loadOrCreateRelayIdentity(stateDir), daemonUrl: `${base}/v2/daemon`, phoneUrl: `${base}/v2/phone` }
    } catch (e) {
      log('TUNNEL', `relay v2 disabled this boot: ${e instanceof Error ? e.message : String(e)} (legacy relay still on)`)
    }
  }
  const remoteInfo = v2 ? { id: v2.identity.id, relay: v2.phoneUrl } : { id: legacy.id, relay: legacy.phoneUrl }
  return { legacy, v2, remoteInfo }
}

/** 两条隧道上订阅着的设备令牌 → 设备 id 集合(同一台手机从哪条连着都算在线)。 */
export function mergeOnlineDevices(sets: Array<Iterable<string>>, idOf: (token: string) => string): Set<string> {
  const out = new Set<string>()
  for (const s of sets) for (const t of s) out.add(idOf(t))
  return out
}
