import type { InboundCtx, Middleware } from './types'
import { INTENT_ORDER, type Intent, type IntentKind } from './intent'
import { intentAnswerTarget, namedAnswerTarget, recordAnswerTarget, type AnswerProvider } from './answer-target'

/** 只读探针:这条消息会不会被这个消费者吃掉。可以是异步(管家的指称解析要问便宜模型)。 */
export type IntentProbe = (ctx: InboundCtx) => boolean | Intent | null | Promise<boolean | Intent | null>

export interface RouteMwDeps {
  providers?: () => readonly AnswerProvider[]
  unavailableNames?: () => readonly string[]
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
    let target: InboundCtx['target']
    for (const kind of INTENT_ORDER) {
      // 命令及有效回答先走原入口。明确点名先于指称/焦点，不碰它们的状态。
      if (kind === 'task-reference' && deps.providers) {
        const named = namedAnswerTarget(ctx.msg.text ?? '', deps.providers(), deps.unavailableNames?.())
        if (named) { target = named; break }
      }
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
    ctx.target = target ?? intentAnswerTarget(intent)
    ctx.msg.answerTarget = Object.freeze({ ...ctx.target, requestId: ctx.requestId })
    // 老嵌入没有目标目录时仍保留原 ROUTE 日志契约。
    if (deps.providers) recordAnswerTarget(deps.log, ctx.requestId, ctx.target)
    await next()
  }
}
