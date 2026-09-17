import type { Middleware } from './types'

/**
 * mw-matter — 每个进门的微信 chat 都对应一条「一件事」(kind='chat' 的 matter),首次入站时
 * 建、之后每次刷新露面时间。放在 access / dedup 之后:没过门的和重投的不算。
 * 只登记,不改任何回复逻辑;登记失败也不打断这一轮。
 */
export interface MatterMwDeps {
  ensureChat(chatId: string): unknown
  log: (tag: string, line: string) => void
}

export function makeMwMatter(deps: MatterMwDeps): Middleware {
  return async (ctx, next) => {
    try { deps.ensureChat(ctx.msg.chatId) }
    catch (err) { deps.log('MATTER', `ensureChat failed for ${ctx.msg.chatId}: ${err instanceof Error ? err.message : err}`) }
    await next()
  }
}
