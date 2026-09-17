import type { InboundCtx, Middleware } from './types'
import { INTENT_ORDER, type Intent, type IntentKind } from './intent'

/** 只读探针:这条消息会不会被这个消费者吃掉。可以是异步(管家的指称解析要问便宜模型)。 */
export type IntentProbe = (ctx: InboundCtx) => boolean | Intent | null | Promise<boolean | Intent | null>

export interface RouteMwDeps {
  probes: Partial<Record<Exclude<IntentKind, 'chat'>, IntentProbe>>
  /** 这条消息落到哪件事(chat 的 matter);没有登记处就不填。 */
  matterFor?: (chatId: string) => string | null
  log: (tag: string, line: string) => void
}

/**
 * mw-route — 按 INTENT_ORDER 问一遍探针,第一个说"是"的就是 intent;都不是就是 chat。
 * 只写 ctx.intent,不消费、不回复;探针抛错当"不是"(并记一行),绝不让一条消息处理不下去。
 */
export function makeMwRoute(deps: RouteMwDeps): Middleware {
  return async (ctx, next) => {
    let intent: Intent = { kind: 'chat' }
    for (const kind of INTENT_ORDER) {
      const probe = deps.probes[kind]
      if (!probe) continue
      try {
        const r = await probe(ctx)
        if (r === true) { intent = { kind }; break }
        if (r && typeof r === 'object') { intent = { ...r, kind: r.kind ?? kind }; break }
      } catch (err) {
        deps.log('ROUTE', `probe ${kind} threw for chat=${ctx.msg.chatId}: ${err instanceof Error ? err.message : err}`)
      }
    }
    if (intent.matterId === undefined && deps.matterFor) { try { intent.matterId = deps.matterFor(ctx.msg.chatId) } catch { intent.matterId = null } }
    ctx.intent = intent
    await next()
  }
}
