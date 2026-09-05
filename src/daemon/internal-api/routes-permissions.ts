/**
 * routes-permissions.ts — 一个权限,两个呈现面(spec 2026-09-05-cc-desktop-pet §6)。
 *
 * 桌面在这里 resolve,微信回「y/n <hash>」走 ilink-glue —— 两边最终都是同一个
 * PendingPermissions.consume(),所以从哪边拍板都算数,另一边随之消失。
 *
 * 分级 admin:拍板一条权限等于替主人对 agent 说「可以动手」,这是主人本人的事,
 * 不是任何 trusted 联系人的事(与 /v1/companion/converse 同级)。
 * 校验内联(不进 schema.ts),照 wish / intro 的先例。
 */
import type { InternalApiDeps, RouteTable } from './types'

export function permissionRoutes(deps: InternalApiDeps): RouteTable {
  return {
    'GET /v1/permissions/pending': async () => {
      if (!deps.permissions) return { status: 503, body: { error: 'permissions_not_wired' } }
      return { status: 200, body: { items: deps.permissions.list() } }
    },
    'POST /v1/permissions/resolve': async (_query, body) => {
      if (!deps.permissions) return { status: 503, body: { error: 'permissions_not_wired' } }
      const b = (body ?? {}) as { hash?: unknown; decision?: unknown }
      if (typeof b.hash !== 'string' || b.hash === '' || (b.decision !== 'allow' && b.decision !== 'deny')) {
        return { status: 400, body: { error: 'bad_request' } }
      }
      // ok=false 不是错误:hash 过期 / 已经被微信那边拍过了。桌面据此收掉卡片。
      return { status: 200, body: { ok: deps.permissions.resolve(b.hash, b.decision) } }
    },
  }
}
