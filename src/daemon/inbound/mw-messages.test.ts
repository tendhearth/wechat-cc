import { describe, it, expect } from 'vitest'
import { makeMwMessages } from './mw-messages'
import type { InboundCtx } from './types'

function ctx(text: string, consumed?: InboundCtx['consumedBy']): InboundCtx {
  return {
    msg: { chatId: 'c1', userId: 'u1', text, msgType: 'text', createTimeMs: 1780000000000, accountId: 'a1' } as InboundCtx['msg'],
    receivedAtMs: 1780000000500,
    requestId: 'r1',
    ...(consumed ? { consumedBy: consumed } : {}),
  }
}

describe('mw-messages', () => {
  it('records inbound text before next() so consumed commands still land', async () => {
    const appended: Array<Record<string, unknown>> = []
    const mw = makeMwMessages({
      append: async rec => { appended.push(rec as unknown as Record<string, unknown>) },
      log: () => {},
    })
    const c = ctx('/health')
    await mw(c, async () => { c.consumedBy = 'admin' })
    expect(appended.length).toBe(1)
    expect(appended[0]).toMatchObject({ id: 'u1:1780000000000', kind: 'command', direction: 'in', text: '/health' })
  })

  it('plain text records kind=text', async () => {
    const appended: Array<Record<string, unknown>> = []
    const mw = makeMwMessages({ append: async rec => { appended.push(rec as never) }, log: () => {} })
    await mw(ctx('你好'), async () => {})
    expect(appended[0]).toMatchObject({ kind: 'text', text: '你好' })
  })

  it('append failure logs but does not break the pipeline', async () => {
    const logs: string[] = []
    const mw = makeMwMessages({
      append: async () => { throw new Error('disk full') },
      log: (_tag, line) => { logs.push(line) },
    })
    let nextRan = false
    await mw(ctx('hi'), async () => { nextRan = true })
    expect(nextRan).toBe(true)
    expect(logs.join(' ')).toContain('disk full')
  })
})
