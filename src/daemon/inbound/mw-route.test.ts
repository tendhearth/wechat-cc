import { describe, expect, it } from 'vitest'
import { makeMwRoute, type RouteMwDeps } from './mw-route'
import { INTENT_ORDER } from './intent'
import type { InboundCtx } from './types'

/**
 * mw-route:按 INTENT_ORDER 问探针,第一个说"是"的定 intent;都不是 ⇒ chat。
 * 只写 ctx.intent,永远 next();探针抛错记一行当"不是"。
 */
const ctxOf = (text = 'hi', chatId = 'c1'): InboundCtx => ({ msg: { chatId, userId: 'u', text, msgType: 'text', createTimeMs: 0, accountId: 'a' }, receivedAtMs: 0, requestId: 'r' })
async function run(deps: Partial<RouteMwDeps>, ctx = ctxOf()) {
  const logs: string[] = []
  let nexted = false
  await makeMwRoute({ probes: {}, log: (t, l) => logs.push(`${t} ${l}`), ...deps })(ctx, async () => { nexted = true })
  return { intent: ctx.intent, nexted, logs }
}

describe('mw-route', () => {
  it('没有探针说"是" ⇒ chat,并且照样 next()', async () => {
    const r = await run({ probes: { admin: () => false, mode: () => null } })
    expect(r.intent).toEqual({ kind: 'chat' }); expect(r.nexted).toBe(true)
  })
  it('按 INTENT_ORDER 取第一个说"是"的,后面的探针不再问', async () => {
    const asked: string[] = []
    const probes = Object.fromEntries(INTENT_ORDER.map(k => [k, () => { asked.push(k); return k === 'mode' || k === 'cli-reply' }])) as RouteMwDeps['probes']
    const r = await run({ probes })
    expect(r.intent?.kind).toBe('mode'); expect(asked).toEqual(['task-command', 'admin', 'mode'])
  })
  it('探针可以直接交回 Intent(带 data),异步也行', async () => {
    const r = await run({ probes: { admin: () => false, 'task-reference': async () => ({ kind: 'task-reference', data: { picked: 'x' } }) } })
    expect(r.intent).toEqual({ kind: 'task-reference', data: { picked: 'x' } })
  })
  it('探针抛错 ⇒ 记 ROUTE 一行、当"不是"、继续往下问', async () => {
    const r = await run({ probes: { admin: () => { throw new Error('boom') }, mode: () => true } })
    expect(r.intent?.kind).toBe('mode'); expect(r.logs).toEqual(['ROUTE probe admin threw for chat=c1: boom']); expect(r.nexted).toBe(true)
  })
  it('有登记处 ⇒ 顺手填这条消息落到哪件事;查不到 / 查坏了都是 null', async () => {
    expect((await run({ matterFor: c => c === 'c1' ? 'deadbeef' : null })).intent).toEqual({ kind: 'chat', matterId: 'deadbeef' })
    expect((await run({ matterFor: () => { throw new Error('db') } })).intent).toEqual({ kind: 'chat', matterId: null })
    expect((await run({ probes: { admin: () => ({ kind: 'admin', matterId: 'ffffffff' }) }, matterFor: () => 'deadbeef' })).intent?.matterId).toBe('ffffffff')
  })
})
