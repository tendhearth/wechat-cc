import type { Middleware, InboundCtx } from './types'
import { routedAway } from './intent'

export interface ModeHandler {
  handle(msg: InboundCtx['msg']): Promise<boolean>
}

export interface ModeMwDeps {
  modeHandler: ModeHandler
}

export function makeMwMode(deps: ModeMwDeps): Middleware {
  return async (ctx, next) => {
    if (routedAway(ctx, 'mode')) { await next(); return }
    if (await deps.modeHandler.handle(ctx.msg)) {
      ctx.consumedBy = 'mode'
      return
    }
    await next()
  }
}
