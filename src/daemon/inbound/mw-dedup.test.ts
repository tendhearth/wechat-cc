import { describe, it, expect } from 'vitest'
import { makeMwDedup } from './mw-dedup'
import { compose } from './compose'
import type { InboundCtx, Middleware } from './types'
import { openTestDb } from '../../lib/db'
import { makeDedupStore } from '../../lib/dedup-store'

function ctx(text: string, createTimeMs = 1780000000000): InboundCtx {
  return {
    msg: { chatId: 'c1', userId: 'u1', text, msgType: 'text', createTimeMs, accountId: 'a1' } as InboundCtx['msg'],
    receivedAtMs: 1780000000500,
    requestId: 'r1',
  }
}

function wire() {
  const store = makeDedupStore(openTestDb())
  const dedup = makeMwDedup({
    isHandled: id => store.isHandled(id),
    markHandled: id => store.markHandled(id, '2026-06-25T00:00:00Z'),
    log: () => {},
  })
  return { dedup, store }
}

describe('mw-dedup', () => {
  it('runs downstream once for a message delivered twice (the sleep/wake re-reply bug)', async () => {
    const { dedup } = wire()
    let dispatched = 0
    const terminal: Middleware = async () => { dispatched++ }
    const run = compose([dedup, terminal])

    await run(ctx('你好'))
    await run(ctx('你好')) // redelivery of the SAME message (same userId:createTimeMs)

    expect(dispatched).toBe(1)
  })

  it('two genuinely different messages both run', async () => {
    const { dedup } = wire()
    let dispatched = 0
    const terminal: Middleware = async () => { dispatched++ }
    const run = compose([dedup, terminal])

    await run(ctx('消息甲', 1780000000000))
    await run(ctx('消息乙', 1780000000001))

    expect(dispatched).toBe(2)
  })

  it('does NOT mark handled when downstream throws — redelivery re-processes (crash recovery)', async () => {
    const { dedup } = wire()
    let attempts = 0
    const terminal: Middleware = async () => {
      attempts++
      if (attempts === 1) throw new Error('agent turn crashed mid-reply')
    }
    const run = compose([dedup, terminal])

    await expect(run(ctx('做个长任务'))).rejects.toThrow('crashed')
    // The first turn threw before a reply was sent, so the message must be
    // redelivered and re-processed — not silently dropped.
    await run(ctx('做个长任务'))

    expect(attempts).toBe(2)
  })

  it('short-circuits a redelivery without invoking downstream at all', async () => {
    const { dedup, store } = wire()
    const terminal: Middleware = async () => {}
    const run = compose([dedup, terminal])
    await run(ctx('hi'))
    expect(store.isHandled('u1:1780000000000')).toBe(true)

    // Second delivery: downstream must not even be entered.
    let entered = false
    const spy: Middleware = async () => { entered = true }
    await compose([dedup, spy])(ctx('hi'))
    expect(entered).toBe(false)
  })
})
