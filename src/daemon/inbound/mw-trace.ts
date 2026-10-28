import type { Middleware } from './types'

export interface TraceMwDeps {
  log: (tag: string, line: string, fields?: Record<string, unknown>) => void
}

function errMsg(err: unknown): string { return err instanceof Error ? err.message : String(err) }

/** 抛了就写 error(带上抛之前认领它的那一站,如果有),别写成「进了对话」—— 排查重投时最要看的就是这一行(#483 评审)。 */
function consumedLabel(consumedBy: string | undefined, threw: boolean): string {
  if (threw) return consumedBy ? `error:${consumedBy}` : 'error'
  return consumedBy ?? 'dispatched'
}

export function makeMwTrace(deps: TraceMwDeps): Middleware {
  return async (ctx, next) => {
    const start = Date.now()
    let threw = false
    try {
      await next()
    } catch (err) {
      threw = true
      deps.log('INBOUND_ERROR', `req=${ctx.requestId} chat=${ctx.msg.chatId} threw: ${errMsg(err)}`, {
        event: 'inbound_uncaught',
        request_id: ctx.requestId,
        chat_id: ctx.msg.chatId,
        error: errMsg(err),
      })
      // 不 rethrow —— 保 polling loop 活
    } finally {
      deps.log('INBOUND',
        `req=${ctx.requestId} chat=${ctx.msg.chatId} intent=${ctx.intent?.kind ?? '-'}${ctx.intent?.matterId ? ` matter=${ctx.intent.matterId}` : ''} consumed=${consumedLabel(ctx.consumedBy, threw)} ms=${Date.now() - start}`)
    }
  }
}
