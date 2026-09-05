import type { Middleware } from './types'

export interface PermissionReplyMwDeps {
  /** 第二个参数是发这句话的 chat —— 拍板权归当初被问的那个 chat(见 ilink-glue)。 */
  handlePermissionReply(text: string, fromChatId?: string): boolean
  log: (tag: string, line: string) => void
}

export function makeMwPermissionReply(deps: PermissionReplyMwDeps): Middleware {
  return async (ctx, next) => {
    if (deps.handlePermissionReply(ctx.msg.text ?? '', ctx.msg.chatId)) {
      deps.log('PERMISSION', `consumed reply from chat=${ctx.msg.chatId}`)
      ctx.consumedBy = 'permission-reply'
      return
    }
    await next()
  }
}
