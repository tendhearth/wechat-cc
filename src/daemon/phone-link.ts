/**
 * 桌面「连接手机」的状态判定与链接拼法(spec 2026-10-01-tendhearth-pairing-ux §4.1)。纯函数,无 IO。
 * 只读 relay_v2_url 是否配置(主人事项,这里从不写它)。
 */
import { RELAY_ID_RE } from '@wechat-cc/protocol'

export type PhoneLinkState = 'ready' | 'starting' | 'remote_off' | 'relay_not_configured' | 'relay_unavailable' | 'no_owner'
export type PhoneLinkResult =
  | { ok: true; state: 'ready'; url: string; expires_at: number }
  | { ok: false; state: Exclude<PhoneLinkState, 'ready'> }

export interface PhoneLinkInputs {
  /** 绑了微信主人没有。 */
  owner: boolean
  /** agent-config.json 的 relay_v2_url 非空(现在的配置,不是开机时的)。 */
  v2Configured: boolean
  /** agent-config.json 的 remote_tunnel === true(现在的配置)。 */
  tunnelOn: boolean
  /** 这次启动实际连上的远程隧道 id(开机时定的);没开隧道 ⇒ null。 */
  bootRemoteId: string | null
}

export function phoneLinkState(i: PhoneLinkInputs): PhoneLinkState {
  if (!i.owner) return 'no_owner'
  if (!i.v2Configured) return 'relay_not_configured'
  if (!i.tunnelOn) return 'remote_off'
  if (i.bootRemoteId === null) return 'starting'
  if (!RELAY_ID_RE.test(i.bootRemoteId)) return 'relay_unavailable'
  return 'ready'
}

/** 中继上的公网壳页链接;令牌在 # 锚点里(锚点不上服务器,中继看不到)。 */
export function psetUrl(remote: { relay: string; id: string }, token: string, lan: string | null): string {
  const base = remote.relay.replace(/^wss:/, 'https:').replace(/\/(tunnel|v2)\/phone$/, '')
  return `${base}/pset/#id=${encodeURIComponent(remote.id)}&t=${token}&p=${encodeURIComponent('/set')}${lan ? `&lan=${lan}` : ''}`
}
