import { describe, it, expect, vi } from 'vitest'
import { makeTaskCommand } from './task-command'
import { makeCommandRegistry } from './registry'
import { makeMwCommand } from '../inbound/mw-command'
import type { InboundCtx, Middleware } from '../inbound/types'
import type { Intent } from '../inbound/intent'

/**
 * 「任务 …」命令(步 4:从 mw-workbench 搬进命令表)。断言沿用 mw-workbench 原来的那几条:
 * 出生地、兜底文字、ilink 报错 ⇒ 抛出(这次投递不标记,等重投)、文件送达 ⇒ 不再发文字。
 */
const ctxOf = (text: string, intent?: Intent, origin?: InboundCtx['origin']): InboundCtx => ({
  msg: { chatId: 'c1', userId: 'u', text, msgType: 'text', createTimeMs: 0, accountId: 'a' }, receivedAtMs: 0, requestId: 'r',
  ...(intent ? { intent } : {}), ...(origin !== undefined ? { origin } : {}),
})
async function run(mw: Middleware, ctx: InboundCtx) { let nexted = false; await mw(ctx, async () => { nexted = true }); return { nexted, consumed: ctx.consumedBy } }
const mwOf = (deps: Parameters<typeof makeTaskCommand>[0]) => makeMwCommand({ registry: makeCommandRegistry([makeTaskCommand(deps)]), log: () => {} })

describe('task-command(命令表第一条)', () => {
  it('probe 只认「任务 …」;id / group 沿用老标签', () => {
    const c = makeTaskCommand({ handleWechat: async () => null, sendMessage: async () => ({}) })
    expect(c.id).toBe('task-command'); expect(c.group).toBe('workbench')
    expect(c.probe(ctxOf('任务 列表').msg)).toBe(true)
    expect(c.probe(ctxOf('hi').msg)).toBe(false)
  })
  it('路由到别人 ⇒ 连 handleWechat 都不调;路由到命令 / 没路由 ⇒ 吃掉,consumedBy=workbench', async () => {
    const handleWechat = vi.fn(async () => '好的')
    const mw = mwOf({ handleWechat, sendMessage: async () => ({}) })
    const away = await run(mw, ctxOf('任务 列表', { kind: 'chat' }))
    expect(away.nexted).toBe(true); expect(handleWechat).not.toHaveBeenCalled()
    const mine = await run(mw, ctxOf('任务 列表', { kind: 'command' }))
    expect(mine).toEqual({ nexted: false, consumed: 'workbench' }); expect(handleWechat).toHaveBeenCalledOnce()
    expect((await run(mw, ctxOf('任务 列表'))).consumed).toBe('workbench')
  })
  it('微信入站不带出生地(⇒ wechat);App 一轮把 daemon 给的出生地(含 null)交下去(2026-10-19)', async () => {
    const handleWechat = vi.fn(async () => '好的')
    const mw = mwOf({ handleWechat, sendMessage: async () => ({}) })
    await run(mw, ctxOf('任务 列表'))
    expect((handleWechat.mock.calls[0] as unknown[])[2]).not.toHaveProperty('origin')
    for (const origin of ['desktop', 'app', 'web', null] as const) {
      await run(mw, ctxOf('任务 列表', undefined, origin))
      expect((handleWechat.mock.calls.at(-1) as unknown[])[2]).toMatchObject({ origin, text: '任务 列表', chatId: 'c1' })
    }
  })
  it('回话:字符串原样发;null ⇒ 兜底「仅对已绑定的主人开放」;文件已送达(对象)⇒ 不发文字', async () => {
    const sendMessage = vi.fn(async () => ({}))
    let reply: string | null | { kind: 'artifact_delivered'; receiptId: string } = '结果'
    const mw = mwOf({ handleWechat: async () => reply, sendMessage })
    await run(mw, ctxOf('任务 abcd1234'))
    expect(sendMessage).toHaveBeenLastCalledWith('c1', '结果')
    reply = null
    await run(mw, ctxOf('任务 abcd1234'))
    expect(sendMessage).toHaveBeenLastCalledWith('c1', '任务控制仅对已绑定的主人开放。')
    reply = { kind: 'artifact_delivered', receiptId: 'r1' }
    expect(await run(mw, ctxOf('任务 abcd1234'))).toEqual({ nexted: false, consumed: 'workbench' })
    expect(sendMessage).toHaveBeenCalledTimes(2)
  })
  it('ilink 返回 error 结果(不 reject)⇒ 抛 workbench_reply_failed,让这次投递不标记、等重投', async () => {
    const mw = mwOf({ handleWechat: async () => '结果', sendMessage: async () => ({ error: 'send failed' }) })
    await expect(run(mw, ctxOf('任务 abcd1234'))).rejects.toThrow('workbench_reply_failed')
    const ok = mwOf({ handleWechat: async () => '结果', sendMessage: async () => ({ error: undefined }) })
    expect((await run(ok, ctxOf('任务 abcd1234'))).consumed).toBe('workbench')
  })
})
