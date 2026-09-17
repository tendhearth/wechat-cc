import { describe, it, expect, vi } from 'vitest'
import { makeMwAdmin } from './mw-admin'
import { makeMwMode } from './mw-mode'
import { makeMwOnboarding } from './mw-onboarding'
import { makeMwPermissionReply } from './mw-permission-reply'
import { makeMwCliReply } from './mw-cli-reply'
import { makeMwWorkbench } from './mw-workbench'
import { routedAway } from './intent'
import type { InboundCtx, Middleware } from './types'
import type { Intent } from './intent'

/**
 * 意图路由第二步(b):路由判过且不是我 ⇒ 消费者不碰这条消息(连 handle 都不调)。
 * 没路由(intent undefined)⇒ 照旧自己试 —— 旧链和直接组装的测试都不受影响。
 */
const ctxOf = (intent?: Intent, text = '/health'): InboundCtx => ({ msg: { chatId: 'c1', userId: 'u', text, msgType: 'text', createTimeMs: 0, accountId: 'a' }, receivedAtMs: 0, requestId: 'r', ...(intent ? { intent } : {}) })
async function run(mw: Middleware, ctx: InboundCtx) { let nexted = false; await mw(ctx, async () => { nexted = true }); return { nexted, consumed: ctx.consumedBy } }

describe('routedAway', () => {
  it('没路由 ⇒ false;路由到我 ⇒ false;路由到别人(含 chat)⇒ true', () => {
    expect(routedAway({}, 'admin')).toBe(false)
    expect(routedAway({ intent: { kind: 'admin' } }, 'admin')).toBe(false)
    expect(routedAway({ intent: { kind: 'chat' } }, 'admin')).toBe(true)
    expect(routedAway({ intent: { kind: 'mode' } }, 'admin')).toBe(true)
  })
})

describe('六个消费者按 intent 早退', () => {
  const table: Array<[string, string, (handle: () => boolean) => Middleware]> = [
    ['admin', 'admin', h => makeMwAdmin({ adminHandler: { handle: async () => h() } })],
    ['mode', 'mode', h => makeMwMode({ modeHandler: { handle: async () => h() } })],
    ['onboarding', 'onboarding', h => makeMwOnboarding({ onboardingHandler: { handle: async () => h() } })],
    ['permission-reply', 'permission-reply', h => makeMwPermissionReply({ handlePermissionReply: () => h(), log: () => {} })],
    ['cli-reply', 'cli-reply', h => makeMwCliReply({ handle: async () => h(), log: () => {} })],
  ]
  for (const [name, kind, make] of table) {
    it(`${name}:路由到别人 ⇒ 不调 handle 直接 next;路由到我 / 没路由 ⇒ 照常`, async () => {
      const handle = vi.fn(() => true)
      const mw = make(handle)
      const away = await run(mw, ctxOf({ kind: 'chat' }))
      expect(away).toEqual({ nexted: true, consumed: undefined }); expect(handle).not.toHaveBeenCalled()
      const mine = await run(mw, ctxOf({ kind: kind as Intent['kind'] }))
      expect(mine.nexted).toBe(false); expect(mine.consumed).toBe(kind)
      const unrouted = await run(mw, ctxOf())
      expect(unrouted.nexted).toBe(false)
    })
  }
  it('workbench(任务命令):路由到别人 ⇒ 连 handleWechat 都不调', async () => {
    const handleWechat = vi.fn(async () => '好的')
    const mw = makeMwWorkbench({ handleWechat, sendMessage: async () => ({}) })
    const away = await run(mw, ctxOf({ kind: 'chat' }, '任务 列表'))
    expect(away.nexted).toBe(true); expect(handleWechat).not.toHaveBeenCalled()
    const mine = await run(mw, ctxOf({ kind: 'task-command' }, '任务 列表'))
    expect(mine.consumed).toBe('workbench'); expect(handleWechat).toHaveBeenCalledOnce()
    expect((await run(mw, ctxOf(undefined, '任务 列表'))).consumed).toBe('workbench')
  })
})
