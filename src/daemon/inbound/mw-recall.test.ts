import { describe, it, expect, vi } from 'vitest'
import { makeMwRecall, RECALL_MIN_QUERY } from './mw-recall'
import type { InboundCtx } from './types'

function ctxWith(text: string, chatId = 'admin1'): InboundCtx {
  return {
    msg: { chatId, userId: 'u', text, msgType: 'text', createTimeMs: 1, accountId: 'a' },
    receivedAtMs: 1,
    requestId: 'r1',
  }
}

const noopLog = () => {}

describe('makeMwRecall', () => {
  it('attaches recall items for an admin chat before calling next', async () => {
    let recallAtNext: string[] | undefined
    const mw = makeMwRecall({
      recall: vi.fn(async () => ['a', 'b']),
      isAdmin: () => true,
      log: noopLog,
    })
    const ctx = ctxWith('最近上海的事')
    await mw(ctx, async () => { recallAtNext = ctx.msg.recall })
    expect(recallAtNext).toEqual(['a', 'b'])
  })

  it('no recall fn wired → passthrough, msg.recall undefined, next still called', async () => {
    const next = vi.fn(async () => {})
    const ctx = ctxWith('最近上海的事')
    await makeMwRecall({ isAdmin: () => true, log: noopLog })(ctx, next)
    expect(ctx.msg.recall).toBeUndefined()
    expect(next).toHaveBeenCalled()
  })

  it('non-admin chat → kernel recall fn NOT called', async () => {
    const recall = vi.fn(async () => ['x'])
    const ctx = ctxWith('最近上海的事', 'guest1')
    await makeMwRecall({ recall, isAdmin: () => false, log: noopLog })(ctx, async () => {})
    expect(recall).not.toHaveBeenCalled()
    expect(ctx.msg.recall).toBeUndefined()
  })

  it('non-admin chat uses recallFallback (own-memory lane) when wired', async () => {
    const recall = vi.fn(async () => ['kernel'])
    const recallFallback = vi.fn(async () => ['[notes/a.md] 上次说的事'])
    const ctx = ctxWith('最近上海的事', 'guest1')
    await makeMwRecall({ recall, recallFallback, isAdmin: () => false, log: noopLog })(ctx, async () => {})
    expect(recall).not.toHaveBeenCalled()
    expect(recallFallback).toHaveBeenCalledWith('guest1', '最近上海的事')
    expect(ctx.msg.recall).toEqual(['[notes/a.md] 上次说的事'])
  })

  it('admin chat prefers the kernel lane even when fallback is wired', async () => {
    const recall = vi.fn(async () => ['kernel'])
    const recallFallback = vi.fn(async () => ['own'])
    const ctx = ctxWith('最近上海的事')
    await makeMwRecall({ recall, recallFallback, isAdmin: () => true, log: noopLog })(ctx, async () => {})
    expect(ctx.msg.recall).toEqual(['kernel'])
    expect(recallFallback).not.toHaveBeenCalled()
  })

  it('fallback errors are swallowed like kernel errors', async () => {
    const next = vi.fn(async () => {})
    const ctx = ctxWith('最近上海的事', 'guest1')
    await makeMwRecall({
      recallFallback: async () => { throw new Error('fs boom') },
      isAdmin: () => false,
      log: noopLog,
    })(ctx, next)
    expect(ctx.msg.recall).toBeUndefined()
    expect(next).toHaveBeenCalled()
  })

  it('recall fn throws → passthrough without recall, logged, next still called', async () => {
    const log = vi.fn()
    const next = vi.fn(async () => {})
    const ctx = ctxWith('最近上海的事')
    await makeMwRecall({
      recall: async () => { throw new Error('embedder down') },
      isAdmin: () => true,
      log,
    })(ctx, next)
    expect(ctx.msg.recall).toBeUndefined()
    expect(next).toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith('RECALL', expect.stringContaining('embedder down'))
  })

  it('recall slower than timeoutMs → passthrough without recall', async () => {
    const ctx = ctxWith('最近上海的事')
    const next = vi.fn(async () => {})
    await makeMwRecall({
      recall: () => new Promise((r) => setTimeout(() => r(['late']), 200)),
      isAdmin: () => true,
      timeoutMs: 10,
      log: noopLog,
    })(ctx, next)
    expect(ctx.msg.recall).toBeUndefined()
    expect(next).toHaveBeenCalled()
  })

  it(`short text (<${RECALL_MIN_QUERY} chars) → recall fn not called`, async () => {
    const recall = vi.fn(async () => ['x'])
    await makeMwRecall({ recall, isAdmin: () => true, log: noopLog })(ctxWith('嗯'), async () => {})
    expect(recall).not.toHaveBeenCalled()
  })

  it('empty result array → msg.recall stays undefined', async () => {
    const ctx = ctxWith('最近上海的事')
    await makeMwRecall({ recall: async () => [], isAdmin: () => true, log: noopLog })(ctx, async () => {})
    expect(ctx.msg.recall).toBeUndefined()
  })
})
