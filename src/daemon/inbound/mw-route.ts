import type { InboundCtx, Middleware } from './types'
import { INTENT_ORDER, type Intent, type IntentKind } from './intent'
import { intentAnswerTarget, recordAnswerTarget, type AnswerProvider } from './answer-target'
import { makeAnswerRouting } from './answer-routing'
import type { AnswerJudge } from './answer-fallback'

/** 只读探针:这条消息会不会被这个消费者吃掉。可以是异步(管家的指称解析要问便宜模型)。 */
export type IntentProbe = (ctx: InboundCtx) => boolean | Intent | null | Promise<boolean | Intent | null>

export interface RouteMwDeps {
  judge?: AnswerJudge
  now?: () => number
  clearFocus?: (chatId: string) => void
  sendMessage?: (chatId: string, text: string) => Promise<unknown>
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
export function makeMwRoute(deps: RouteMwDeps): Middleware & { consume: Middleware } {
  const answers = makeAnswerRouting(deps)
  const mw: Middleware = async (ctx, next) => {
    let intent: Intent = { kind: 'chat' }
    let target: InboundCtx['target']
    for (const kind of INTENT_ORDER) {
      // 命令及有效回答先走原入口。明确点名先于指称/焦点，不碰它们的状态。
      if (kind === 'task-reference' && deps.providers) {
        const named = answers.before(ctx)
        if (named) { target = named; break }
      }
      const probe = deps.probes[kind]
      if (!probe) continue
      try {
        // 事项探针也可能等模型；先留下回执，期间的退出/改投不能被旧结果覆盖。
        if (kind === 'task-reference' && deps.providers) answers.reserve(ctx)
        const r = await probe(ctx)
        const corrected = answers.corrected(ctx)
        if (corrected) { target = corrected; intent = { kind: 'chat' }; break }
        if (r === true) { intent = { kind }; break }
        if (r && typeof r === 'object') { intent = { ...r, kind: r.kind ?? kind }; break }
      } catch (err) {
        deps.log('ROUTE', `probe ${kind} threw for chat=${ctx.msg.chatId}: ${err instanceof Error ? err.message : err}`)
      }
    }
    if (intent.matterId === undefined && deps.matterFor) { try { intent.matterId = deps.matterFor(ctx.msg.chatId) } catch { intent.matterId = null } }
    ctx.intent = intent
    ctx.target = target ?? answers.corrected(ctx) ?? (intent.kind === 'chat' ? await answers.fallback(ctx) : intentAnswerTarget(intent))
    if (!target && intent.kind === 'task-reference') answers.rememberMatter(ctx, ctx.target)
    ctx.msg.answerTarget = Object.freeze({ ...ctx.target, requestId: ctx.msg.answerRoute?.requestId ?? ctx.requestId })
    // 老嵌入没有目标目录时仍保留原 ROUTE 日志契约。
    if (deps.providers) recordAnswerTarget(deps.log, ctx.requestId, ctx.target, ctx.msg.answerRoute?.requestId)
    await next()
  }
  return Object.assign(mw, { consume: answers.consume })
}
