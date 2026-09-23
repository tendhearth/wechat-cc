import type { InboundCtx, Middleware } from './types'
import { INTENT_ORDER, type IntentKind } from './intent'

/**
 * mw-consume — 意图路由第三步(c):七个消费型中间件收成一张表,链上只剩这一站。
 *
 * 有 intent(mw-route 判过):只把消息交给它对应的那个消费者;它没吃(handle 说不是)⇒ 进对话。
 * 没 intent(旧链 / 直接组装的测试):按 INTENT_ORDER 逐个试,谁先吃谁赢 —— 就是原来的链序。
 * 消费者本身还是原来的中间件(签名不变),"吃了"= 没调 next。
 */
export interface ConsumeMwDeps {
  handlers: Partial<Record<Exclude<IntentKind, 'chat'>, Middleware>>
}

export function makeMwConsume(deps: ConsumeMwDeps): Middleware {
  const tryOne = async (mw: Middleware, ctx: InboundCtx): Promise<boolean> => {
    let fell = false
    await mw(ctx, async () => { fell = true })
    return !fell
  }
  return async (ctx, next) => {
    if (ctx.intent !== undefined) {
      const mw = ctx.intent.kind === 'chat' ? undefined : deps.handlers[ctx.intent.kind]
      if (mw && await tryOne(mw, ctx)) return
      await next()
      return
    }
    for (const kind of INTENT_ORDER) {
      const mw = deps.handlers[kind]
      if (mw && await tryOne(mw, ctx)) return
    }
    await next()
  }
}

/** 路由判成这些意图时跳过这一站(没路由 ⇒ 照跑)。用来保住原链里"谁在谁前面"的副作用语义。 */
export const skipFor = (kinds: readonly IntentKind[], mw: Middleware): Middleware =>
  (ctx, next) => ctx.intent !== undefined && kinds.includes(ctx.intent.kind) ? next() : mw(ctx, next)

/** 按谓词跳过这一站(路由之前用,比如"打字中"不给任务命令发)。 */
export const skipWhen = (pred: (ctx: InboundCtx) => boolean, mw: Middleware): Middleware =>
  (ctx, next) => pred(ctx) ? next() : mw(ctx, next)
