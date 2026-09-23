import type { Middleware, InboundCtx } from './types'
import { routedAway } from './intent'

export interface AdminHandler {
  handle(msg: InboundCtx['msg']): Promise<boolean>
}

export interface AdminMwDeps {
  adminHandler: AdminHandler
}

export function makeMwAdmin(deps: AdminMwDeps): Middleware {
  return async (ctx, next) => {
    if (routedAway(ctx, 'admin')) { await next(); return }
    if (await deps.adminHandler.handle(ctx.msg)) {
      ctx.consumedBy = 'admin'
      return
    }
    await next()
  }
}
