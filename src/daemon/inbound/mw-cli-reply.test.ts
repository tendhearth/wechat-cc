import { describe, it, expect, vi } from 'vitest'
import { makeMwCliReply } from './mw-cli-reply'
import type { InboundCtx } from './types'

const ctx = (text: string): InboundCtx => ({ msg: { chatId: 'c', userId: 'u', text, msgType: 'text', createTimeMs: 0 }, receivedAtMs: 0, requestId: 'r' } as unknown as InboundCtx)

describe('mw-cli-reply', () => {
  it('handle 说是 → consumedBy=cli-reply,不往下走;说不是 → next', async () => {
    const next = vi.fn(async () => {})
    const mw = makeMwCliReply({ handle: async (t) => t.startsWith('看 '), log: () => {} })
    const a = ctx('看 a1b2c3'); await mw(a, next)
    expect(a.consumedBy).toBe('cli-reply'); expect(next).not.toHaveBeenCalled()
    const b = ctx('hello'); await mw(b, next)
    expect(b.consumedBy).toBeUndefined(); expect(next).toHaveBeenCalledTimes(1)
  })
})
