import { describe, it, expect, vi } from 'vitest'
import { makeMwConsume, skipFor, skipWhen } from './mw-consume'
import type { InboundCtx, Middleware } from './types'
import type { Intent } from './intent'

/**
 * mw-consume:有 intent 只交给对应的消费者;它没吃 ⇒ 进对话(next)。没 intent ⇒ 按 INTENT_ORDER 逐个试。
 */
const ctxOf = (intent?: Intent): InboundCtx => ({ msg: { chatId: 'c', userId: 'u', text: 'x', msgType: 'text', createTimeMs: 0, accountId: 'a' }, receivedAtMs: 0, requestId: 'r', ...(intent ? { intent } : {}) })
const consumer = (name: string, eats: boolean, calls: string[]): Middleware => async (ctx, next) => { calls.push(name); if (eats) { ctx.consumedBy = name as InboundCtx['consumedBy']; return } await next() }
async function run(mw: Middleware, ctx: InboundCtx) { let nexted = false; await mw(ctx, async () => { nexted = true }); return { nexted, consumed: ctx.consumedBy } }

describe('mw-consume', () => {
  it('有 intent:只调对应的消费者,别的连碰都不碰', async () => {
    const calls: string[] = []
    const mw = makeMwConsume({ handlers: { admin: consumer('admin', true, calls), mode: consumer('mode', true, calls) } })
    expect(await run(mw, ctxOf({ kind: 'mode' }))).toEqual({ nexted: false, consumed: 'mode' })
    expect(calls).toEqual(['mode'])
  })
  it('有 intent 但消费者没吃 ⇒ 进对话;intent=chat ⇒ 谁也不调直接进对话;没这个消费者也进对话', async () => {
    const calls: string[] = []
    const mw = makeMwConsume({ handlers: { admin: consumer('admin', false, calls) } })
    expect(await run(mw, ctxOf({ kind: 'admin' }))).toEqual({ nexted: true, consumed: undefined })
    expect(await run(mw, ctxOf({ kind: 'chat' }))).toEqual({ nexted: true, consumed: undefined })
    expect(await run(mw, ctxOf({ kind: 'cli-reply' }))).toEqual({ nexted: true, consumed: undefined })
    expect(calls).toEqual(['admin'])
  })
  it('没 intent(旧链):按 INTENT_ORDER 逐个试,谁先吃谁赢;都不吃 ⇒ 进对话', async () => {
    const calls: string[] = []
    const mw = makeMwConsume({ handlers: { 'task-reference': consumer('ref', true, calls), mode: consumer('mode', true, calls), admin: consumer('admin', false, calls) } })
    expect(await run(mw, ctxOf())).toEqual({ nexted: false, consumed: 'mode' })
    expect(calls).toEqual(['admin', 'mode'])
    const none = makeMwConsume({ handlers: { admin: consumer('admin', false, calls) } })
    expect((await run(none, ctxOf())).nexted).toBe(true)
  })
})

describe('skipFor / skipWhen', () => {
  it('skipFor:路由判成列出的意图 ⇒ 跳过这一站;别的意图 / 没路由 ⇒ 照跑', async () => {
    const inner = vi.fn<Middleware>(async (_ctx, next) => { await next() })
    const mw = skipFor(['admin', 'task-command'], inner)
    await run(mw, ctxOf({ kind: 'admin' })); expect(inner).not.toHaveBeenCalled()
    await run(mw, ctxOf({ kind: 'chat' })); expect(inner).toHaveBeenCalledTimes(1)
    await run(mw, ctxOf()); expect(inner).toHaveBeenCalledTimes(2)
  })
  it('skipWhen:谓词为真 ⇒ 跳过', async () => {
    const inner = vi.fn<Middleware>(async (_ctx, next) => { await next() })
    const mw = skipWhen(ctx => ctx.msg.text === 'x', inner)
    expect((await run(mw, ctxOf())).nexted).toBe(true); expect(inner).not.toHaveBeenCalled()
  })
})
