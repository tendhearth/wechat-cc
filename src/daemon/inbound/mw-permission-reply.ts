import type { Middleware } from './types'

export interface PermissionReplyMwDeps {
  /** 第二个参数是发这句话的 chat —— 拍板权归当初被问的那个 chat(见 ilink-glue)。 */
  /** 第三个参数是主人引用的那条消息的原文(微信「引用」回复),用来认是哪张卡片。 */
  handlePermissionReply(text: string, fromChatId?: string, quoted?: string): boolean
  log: (tag: string, line: string) => void
}

export function makeMwPermissionReply(deps: PermissionReplyMwDeps): Middleware {
  return async (ctx, next) => {
    if (deps.handlePermissionReply(ctx.msg.text ?? '', ctx.msg.chatId, ctx.msg.quote?.text)) {
      deps.log('PERMISSION', `consumed reply from chat=${ctx.msg.chatId}`)
      ctx.consumedBy = 'permission-reply'
      return
    }
    await next()
  }
}
