import { describe, it, expect, vi } from 'vitest'
import { makeMwCommand } from './mw-command'
import { makeCommandRegistry } from '../commands/registry'
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
    expect(routedAway({}, 'command')).toBe(false)
    expect(routedAway({ intent: { kind: 'command' } }, 'command')).toBe(false)
    expect(routedAway({ intent: { kind: 'chat' } }, 'command')).toBe(true)
    expect(routedAway({ intent: { kind: 'task-command' } }, 'command')).toBe(true)
  })
})

describe('消费者按 intent 早退(3b 之后只剩命令表与工作台)', () => {
  const table: Array<[string, string, (handle: () => boolean) => Middleware]> = [
    ['command', 'command', h => makeMwCommand({ registry: makeCommandRegistry([{ id: 'x', probe: () => true, handle: async () => h() }]), log: () => {} })],
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
  it('workbench(任务命令):微信入站不带出生地(⇒ wechat);App 一轮把 daemon 给的出生地(含 null)交下去(2026-10-19)', async () => {
    const handleWechat = vi.fn(async () => '好的')
    const mw = makeMwWorkbench({ handleWechat, sendMessage: async () => ({}) })
    await run(mw, ctxOf(undefined, '任务 列表'))
    expect((handleWechat.mock.calls[0] as unknown[])[2]).not.toHaveProperty('origin')
    for (const origin of ['desktop', 'app', 'web', null] as const) {
      await run(mw, { ...ctxOf(undefined, '任务 列表'), origin })
      expect((handleWechat.mock.calls.at(-1) as unknown[])[2]).toMatchObject({ origin })
    }
  })
})

describe('命令表的 group 沿用老的 consumedBy 标签(3b)', () => {
  it('admin 那条处理了 ⇒ consumedBy=admin,不是 command', async () => {
    const mw = makeMwCommand({ registry: makeCommandRegistry([{ id: 'admin', group: 'admin', probe: () => true, handle: async () => true }]), log: () => {} })
    expect(await run(mw, ctxOf({ kind: 'command' }))).toEqual({ nexted: false, consumed: 'admin' })
  })
})
