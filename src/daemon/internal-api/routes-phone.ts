import type { InternalApiDeps, RouteTable } from './types'

/**
 * 桌面「连接手机」(spec 2026-10-01-tendhearth-pairing-ux §4.1)。admin 档:桌面经原生宿主的 operator 凭据调用,
 * 渲染进程拿不到令牌。出码会铸 admin 档的链接令牌,所以绝不能降到 trusted(普通聊天会话也是 trusted)。
 */
export function phoneRoutes(deps: InternalApiDeps): RouteTable {
  return {
    'POST /v1/phone/link': async (_q, body) => {
      if (!deps.phoneConnect) return { status: 503, body: { error: 'phone_not_wired' } }
      const b = (body ?? {}) as { enable_remote?: unknown }
      if (b.enable_remote !== undefined && typeof b.enable_remote !== 'boolean') return { status: 400, body: { error: 'invalid_request' } }
      try { return { status: 200, body: await deps.phoneConnect.link({ enableRemote: b.enable_remote === true }) } }
      catch (e) { deps.log?.('INTERNAL_API', `phone_link_failed: ${e instanceof Error ? e.message : 'error'}`); return { status: 503, body: { error: 'unavailable' } } }
    },
    'GET /v1/phone/devices': async () => {
      if (!deps.phoneConnect) return { status: 503, body: { error: 'phone_not_wired' } }
      try { return { status: 200, body: { ok: true, devices: deps.phoneConnect.devices() } } }
      catch (e) { deps.log?.('INTERNAL_API', `phone_devices_failed: ${e instanceof Error ? e.message : 'error'}`); return { status: 503, body: { error: 'unavailable' } } }
    },
  }
}
