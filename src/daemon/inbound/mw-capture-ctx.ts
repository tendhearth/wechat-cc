import type { Middleware } from './types'

export interface CaptureCtxMwDeps {
  markChatActive(chatId: string, accountId: string): void
  captureContextToken(chatId: string, token: string): void
  onContextAvailable?(chatId:string,accountId:string):void
}

export function makeMwCaptureCtx(deps: CaptureCtxMwDeps): Middleware {
  return async (ctx, next) => {
    deps.markChatActive(ctx.msg.chatId, ctx.msg.accountId)
    if (ctx.msg.contextToken) {
      deps.captureContextToken(ctx.msg.chatId, ctx.msg.contextToken)
      deps.onContextAvailable?.(ctx.msg.chatId,ctx.msg.accountId)
    }
    await next()
  }
}
