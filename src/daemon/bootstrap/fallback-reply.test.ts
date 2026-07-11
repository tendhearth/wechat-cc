import { describe, expect, it, vi } from 'vitest'
import { makeSendAssistantText } from './fallback-reply'

describe('makeSendAssistantText (FALLBACK_REPLY diagnostic logger)', () => {
  it('returns undefined when no underlying sendMessage exists', () => {
    const log = vi.fn()
    const r = makeSendAssistantText({ sendMessage: undefined, log })
    expect(r).toBeUndefined()
    expect(log).not.toHaveBeenCalled()
  })

  // The bug v0.5.3 closes: in v0.5.1/0.5.2 the bootstrap wrapper was
  //   `async (chatId, text) => { await deps.ilink.sendMessage(chatId, text) }`
  // which `await`s and discards the `{ msgId, error? }` envelope. When the
  // ilink retry loop gave up after 3 attempts, the wrapper saw the error,
  // dropped it, and the daemon's main flow had no log line about the
  // failure. Channel.log only had `[RETRY_FAIL]` from inside ilink.ts —
  // dashboard "Logs" panel showed neither.
  it('logs [FALLBACK_REPLY_FAIL] with chat + error when ilink returns an error envelope', async () => {
    const log = vi.fn()
    const sendMessage = vi.fn(async () => ({ msgId: 'err:1730', error: 'ilink/sendmessage errcode=-14: session expired' }))
    const wrapper = makeSendAssistantText({ sendMessage, log })
    expect(wrapper).toBeDefined()
    await wrapper!('o9cq...@im.wechat', '回复正文')

    expect(sendMessage).toHaveBeenCalledWith('o9cq...@im.wechat', '回复正文')
    const failCalls = log.mock.calls.filter(([tag]) => tag === 'FALLBACK_REPLY_FAIL')
    expect(failCalls.length).toBe(1)
    const [, line] = failCalls[0]!
    expect(line).toContain('chat=o9cq...@im.wechat')
    expect(line).toContain('errcode=-14')
    // success log MUST NOT also fire on the same call
    expect(log.mock.calls.find(([tag]) => tag === 'FALLBACK_REPLY_SENT')).toBeUndefined()
  })

  it('logs [FALLBACK_REPLY_SENT] with chat + msgId when ilink succeeds', async () => {
    const log = vi.fn()
    const sendMessage = vi.fn(async () => ({ msgId: 'sent:1730' }))
    const wrapper = makeSendAssistantText({ sendMessage, log })
    await wrapper!('o9cq...@im.wechat', '回复正文')

    const sentCalls = log.mock.calls.filter(([tag]) => tag === 'FALLBACK_REPLY_SENT')
    expect(sentCalls.length).toBe(1)
    const [, line] = sentCalls[0]!
    expect(line).toContain('chat=o9cq...@im.wechat')
    expect(line).toContain('msgId=sent:1730')
    expect(log.mock.calls.find(([tag]) => tag === 'FALLBACK_REPLY_FAIL')).toBeUndefined()
  })

  // ilink.sendMessage doesn't throw (returns the error envelope), but a
  // genuinely thrown exception (network unreachable, JSON parse blow-up,
  // etc.) should still be visible. Catch + log [FALLBACK_REPLY_FAIL] +
  // re-throw so the coordinator's outer error handling stays intact.
  it('logs [FALLBACK_REPLY_FAIL] and re-throws when sendMessage itself throws', async () => {
    const log = vi.fn()
    const boom = new Error('ECONNRESET')
    const sendMessage = vi.fn(async () => { throw boom })
    const wrapper = makeSendAssistantText({ sendMessage, log })
    await expect(wrapper!('o9cq...@im.wechat', 'hi')).rejects.toBe(boom)

    const failCalls = log.mock.calls.filter(([tag]) => tag === 'FALLBACK_REPLY_FAIL')
    expect(failCalls.length).toBe(1)
    expect(failCalls[0]![1]).toContain('ECONNRESET')
  })

  // Session-serialization design, Task 2 Part B: an app turn (companionConverse)
  // whose agent emits plain assistant text instead of calling the `reply` tool
  // falls through to sendAssistantText — this is the ONLY place that text can
  // be captured into the open app-conversation-channel sink instead of leaking
  // to WeChat. Mirrors the POST /v1/wechat/reply route's `replySinks.capture`
  // check (routes.ts).
  describe('reply-sink capture (app-conversation-channel)', () => {
    it('captures into the sink and does NOT call sendMessage when a sink is open for the chat', async () => {
      const log = vi.fn()
      const sendMessage = vi.fn(async () => ({ msgId: '1' }))
      const capture = vi.fn(() => true)
      const wrapper = makeSendAssistantText({ sendMessage, log, capture })

      await wrapper!('owner_chat', 'plain assistant text')

      expect(capture).toHaveBeenCalledWith('owner_chat', 'plain assistant text')
      expect(sendMessage).not.toHaveBeenCalled()
      // No FALLBACK_REPLY_SENT/FAIL log — the ilink send path never ran.
      expect(log).not.toHaveBeenCalled()
    })

    it('falls through to sendMessage (WeChat unchanged) when no sink is open for the chat', async () => {
      const log = vi.fn()
      const sendMessage = vi.fn(async () => ({ msgId: '1' }))
      const capture = vi.fn(() => false)
      const wrapper = makeSendAssistantText({ sendMessage, log, capture })

      await wrapper!('some_chat', 'text')

      expect(capture).toHaveBeenCalledWith('some_chat', 'text')
      expect(sendMessage).toHaveBeenCalledWith('some_chat', 'text')
    })

    it('falls through to sendMessage when capture is undefined (no replySinks wired)', async () => {
      const log = vi.fn()
      const sendMessage = vi.fn(async () => ({ msgId: '1' }))
      const wrapper = makeSendAssistantText({ sendMessage, log })

      await wrapper!('some_chat', 'text')

      expect(sendMessage).toHaveBeenCalledWith('some_chat', 'text')
    })
  })
})
