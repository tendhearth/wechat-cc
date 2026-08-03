import { describe, it, expect, vi } from 'vitest'
import { makeMwLlmHealth } from './mw-llm-health'
import type { InboundCtx } from './types'

function ctx(chatId = 'chat-1'): InboundCtx {
  return { msg: { chatId, text: 'hi' } as never, receivedAtMs: 0, requestId: 'r1' }
}

function harness(over: { suspend?: boolean; failures?: number; nowMs?: number } = {}) {
  const sent: string[] = []
  const t = { ms: over.nowMs ?? 0 }
  const mw = makeMwLlmHealth({
    health: {
      shouldSuspend: () => over.suspend ?? false,
      get: () => ({ consecutiveFailures: over.failures ?? 5 }),
    },
    sendMessage: async (_c, text) => { sent.push(text); return { msgId: 'm' } },
    now: () => t.ms,
    log: () => {},
  })
  return { mw, sent, t }
}

describe('mw-llm-health', () => {
  it('healthy 时透明放行', async () => {
    const { mw, sent } = harness({ suspend: false })
    const next = vi.fn(async () => {})
    await mw(ctx(), next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(sent).toEqual([])
  })

  it('degraded 时不进入 LLM 轮次,改回模板话', async () => {
    const { mw, sent } = harness({ suspend: true })
    const next = vi.fn(async () => {})
    await mw(ctx(), next)
    expect(next).not.toHaveBeenCalled()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatch(/没法|暂时/)
  })

  it('模板话是写死的 —— 坏掉的组件不能生成自己的讣告', async () => {
    const { mw, sent } = harness({ suspend: true })
    await mw(ctx(), vi.fn(async () => {}))
    // 不含任何模型生成痕迹:纯静态文案,不调 next 也就没有 provider 参与
    expect(sent[0]).not.toMatch(/undefined|\[object/)
  })

  it('同一 degraded 区间内每个 chat 只回一次,不刷屏', async () => {
    const { mw, sent } = harness({ suspend: true })
    for (let i = 0; i < 5; i += 1) await mw(ctx('chat-1'), vi.fn(async () => {}))
    expect(sent).toHaveLength(1)
  })

  it('不同 chat 各自回一次', async () => {
    const { mw, sent } = harness({ suspend: true })
    await mw(ctx('chat-1'), vi.fn(async () => {}))
    await mw(ctx('chat-2'), vi.fn(async () => {}))
    expect(sent).toHaveLength(2)
  })

  it('达到退避间隔后放行一次真实尝试(探测恢复)', async () => {
    // nextBackoffMs jitters ±20% via Math.random() — pin it to 0.5 (factor=1)
    // so the boundary at exactly 2s is deterministic instead of ~50% flaky.
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const { mw, sent, t } = harness({ suspend: true, failures: 0 })  // 退避 = 2s
    const next = vi.fn(async () => {})
    await mw(ctx(), next)                 // 第一条:拦下并回模板
    expect(next).not.toHaveBeenCalled()

    t.ms = 2_000                          // 到达退避间隔
    await mw(ctx(), next)                 // 放行一次真实尝试
    expect(next).toHaveBeenCalledTimes(1)
    expect(sent).toHaveLength(1)          // 放行的这次不回模板
    randomSpy.mockRestore()
  })

  it('sendMessage 失败不把管线打断', async () => {
    const sendMessage = vi.fn(async () => { throw new Error('wechat also down') })
    const mw = makeMwLlmHealth({
      health: { shouldSuspend: () => true, get: () => ({ consecutiveFailures: 5 }) },
      sendMessage: sendMessage as never,
      now: () => 0,
      log: () => {},
    })
    await expect(mw(ctx(), vi.fn(async () => {}))).resolves.toBeUndefined()
  })

  it('拦下时把 ctx.consumedBy 记为 health(不是借用 guard 的枚举值)', async () => {
    const { mw } = harness({ suspend: true })
    const c = ctx()
    await mw(c, vi.fn(async () => {}))
    expect(c.consumedBy).toBe('health')
  })
})
