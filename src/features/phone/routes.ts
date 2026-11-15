import type { RouteTable } from '../../daemon/internal-api/types'
import type { PhoneLinkResult } from './phone-link'
import type { DeviceRow } from './device-store'
import type { ShareLinkResult } from './share-panel'
import type { MatterShare, TalkRow } from '../../adapters/store/matter-shares'

/** 桌面「连接手机」要的两样:出码(必要时开远程)、列已配对的设备。设置面板建好才有(在 wired 里建)。 */
export interface PhoneConnectDep {
  link(opts: { enableRemote: boolean }): Promise<PhoneLinkResult>
  devices(): DeviceRow[]
  /** 分享一件事给合伙人(主人侧:开、列、撤)。没接工作台 ⇒ 没有,三条路由回 503。 */
  share?: {
    link(matterId: string, name: unknown, mode?: unknown): ShareLinkResult
    list(matterId: string): MatterShare[]
    revoke(matterId: string, shareId: string): boolean
    setMode(matterId: string, shareId: string, mode: unknown): boolean
    /** 这件事里和被分享的人一起聊的那段对话:主人读、主人说。 */
    talk(matterId: string): { talk: TalkRow[]; total: number }
    say(matterId: string, text: string): TalkRow
  }
}

export interface PhoneRoutesDeps {
  /** 设置面板还没建好(wired 之前)⇒ null,两条路由照旧回 503 phone_not_wired。 */
  phoneConnect: () => PhoneConnectDep | null
  /** Explicit consent only; returns true only when the relay was newly configured. */
  enableRelay?: () => boolean
  log?: (tag: string, line: string) => void
}

/**
 * 桌面「连接手机」(spec 2026-10-01-tendhearth-pairing-ux §4.1)。admin 档:桌面经原生宿主的 operator 凭据调用,
 * 渲染进程拿不到令牌。出码会铸 admin 档的链接令牌,所以绝不能降到 trusted(普通聊天会话也是 trusted)。
 */
const ownerDesktop = (caller: { origin: string; tier: string } | undefined): boolean => caller?.origin === 'operator' && caller.tier === 'admin'
const SHARE_ERRORS: Readonly<Record<string, number>> = { matter_not_found: 404, matter_archived: 409, invalid_share_name: 400, invalid_share_mode: 400, too_many_shares: 409 }
function shareError(e: unknown): { status: number; body: { error: string } } {
  const code = e instanceof Error ? e.message : ''
  return code in SHARE_ERRORS ? { status: SHARE_ERRORS[code]!, body: { error: code } } : { status: 500, body: { error: 'internal' } }
}

export function phoneRoutes(deps: PhoneRoutesDeps): RouteTable {
  return {
    // This route has no phone/panel exposure; internal-api listens only on loopback.
    'POST /v1/phone/enable-relay': async (_q, body, caller) => {
      if (caller?.origin !== 'operator' || caller.tier !== 'admin') return { status: 403, body: { error: 'forbidden' } }
      if (body != null && (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 0)) return { status: 400, body: { error: 'invalid_request' } }
      const connect = deps.phoneConnect()
      if (!connect || !deps.enableRelay) return { status: 503, body: { error: 'phone_not_wired' } }
      try {
        if (deps.enableRelay()) deps.log?.('AUDIT', `phone relay enabled by operator at ${new Date().toISOString()} — 桌面「连接手机」`)
        // Reuse the existing startup/restart deduplication and ready-code path.
        return { status: 200, body: await connect.link({ enableRemote: true }) }
      } catch (e) {
        const code = (e as { code?: string })?.code
        if (code === 'config_unreadable' || code === 'config_busy') return { status: 409, body: { error: code } }
        deps.log?.('INTERNAL_API', 'phone_relay_enable_failed')
        return { status: 503, body: { error: 'phone_relay_enable_failed' } }
      }
    },
    'POST /v1/phone/link': async (_q, body) => {
      const connect = deps.phoneConnect()
      if (!connect) return { status: 503, body: { error: 'phone_not_wired' } }
      const b = (body ?? {}) as { enable_remote?: unknown }
      if (b.enable_remote !== undefined && typeof b.enable_remote !== 'boolean') return { status: 400, body: { error: 'invalid_request' } }
      try { return { status: 200, body: await connect.link({ enableRemote: b.enable_remote === true }) } }
      catch (e) { deps.log?.('INTERNAL_API', `phone_link_failed: ${e instanceof Error ? e.message : 'error'}`); return { status: 503, body: { error: 'unavailable' } } }
    },
    // ── 分享一件事给合伙人(主人侧)。只认桌面的 operator 凭据:开链接是对外的动作,聊天会话、执行者、手机链接都不能替主人开。
    'POST /v1/matter/share': async (_q, body, caller) => {
      if (!ownerDesktop(caller)) return { status: 403, body: { error: 'forbidden' } }
      const share = deps.phoneConnect()?.share
      if (!share) return { status: 503, body: { error: 'phone_not_wired' } }
      const b = body as { matter: string; name: string; mode?: string }
      try {
        const out = share.link(b.matter, b.name, b.mode)
        if (out.ok) return { status: 200, body: { share: out.share, url: out.url } }
        return { status: out.error === 'share_unavailable' ? 503 : 409, body: out.error === 'share_relay_not_ready' ? { error: out.error, state: out.state } : { error: out.error } }
      } catch (e) { return shareError(e) }
    },
    'GET /v1/matter/shares': async (q, _b, caller) => {
      if (!ownerDesktop(caller)) return { status: 403, body: { error: 'forbidden' } }
      const share = deps.phoneConnect()?.share
      if (!share) return { status: 503, body: { error: 'phone_not_wired' } }
      try { return { status: 200, body: { shares: share.list(q.get('matter') ?? '') } } } catch (e) { return shareError(e) }
    },
    'POST /v1/matter/share/revoke': async (_q, body, caller) => {
      if (!ownerDesktop(caller)) return { status: 403, body: { error: 'forbidden' } }
      const share = deps.phoneConnect()?.share
      if (!share) return { status: 503, body: { error: 'phone_not_wired' } }
      const b = body as { matter: string; id: string }
      try { return { status: 200, body: { revoked: share.revoke(b.matter, b.id) } } } catch (e) { return shareError(e) }
    },
    'POST /v1/matter/share/mode': async (_q, body, caller) => {
      if (!ownerDesktop(caller)) return { status: 403, body: { error: 'forbidden' } }
      const share = deps.phoneConnect()?.share
      if (!share) return { status: 503, body: { error: 'phone_not_wired' } }
      const b = body as { matter: string; id: string; mode: string }
      try { return { status: 200, body: { changed: share.setMode(b.matter, b.id, b.mode) } } } catch (e) { return shareError(e) }
    },
    'GET /v1/matter/talk': async (q, _b, caller) => {
      if (!ownerDesktop(caller)) return { status: 403, body: { error: 'forbidden' } }
      const share = deps.phoneConnect()?.share
      if (!share) return { status: 503, body: { error: 'phone_not_wired' } }
      try { return { status: 200, body: share.talk(q.get('matter') ?? '') } } catch (e) { return shareError(e) }
    },
    'POST /v1/matter/talk': async (_q, body, caller) => {
      if (!ownerDesktop(caller)) return { status: 403, body: { error: 'forbidden' } }
      const share = deps.phoneConnect()?.share
      if (!share) return { status: 503, body: { error: 'phone_not_wired' } }
      const b = body as { matter: string; text: string }
      try { return { status: 200, body: { line: share.say(b.matter, b.text) } } } catch (e) { return shareError(e) }
    },
    'GET /v1/phone/devices': async () => {
      const connect = deps.phoneConnect()
      if (!connect) return { status: 503, body: { error: 'phone_not_wired' } }
      try { return { status: 200, body: { ok: true, devices: connect.devices() } } }
      catch (e) { deps.log?.('INTERNAL_API', `phone_devices_failed: ${e instanceof Error ? e.message : 'error'}`); return { status: 503, body: { error: 'unavailable' } } }
    },
  }
}
