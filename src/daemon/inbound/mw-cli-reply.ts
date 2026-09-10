import type { Middleware } from './types'

/**
 * 「看 码」「@码 文本」—— 主人对某条终端会话说话(spec 2026-09-09-cli-hook-push §6.4)。
 * 排在权限 y/n 之后、附件之前:它和 y/n 一样是「对通知的答复」,不该进模型。
 */
export interface CliReplyMwDeps {
  handle(text: string, chatId: string): Promise<boolean>
  log: (tag: string, line: string) => void
}

export function makeMwCliReply(deps: CliReplyMwDeps): Middleware {
  return async (ctx, next) => {
    if (await deps.handle(ctx.msg.text ?? '', ctx.msg.chatId)) {
      deps.log('CLI_REPLY', `consumed from chat=${ctx.msg.chatId}`)
      ctx.consumedBy = 'cli-reply'
      return
    }
    await next()
  }
}
