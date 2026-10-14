import { describe, expect, it, vi } from 'vitest'
import { makeSendAssistantText, makeSendNotice } from './fallback-reply'

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
    // 服务端拒了 ⇒ 告诉调用方「没送到」(CLI 推送据此不记 sent)
    expect(await wrapper!('o9cq...@im.wechat', '回复正文')).toBe(false)

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
    expect(await wrapper!('o9cq...@im.wechat', '回复正文')).toBe(true)

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

describe('makeSendAssistantText — shadow 旁听(回复交付 §5.1 第 3 项)', () => {
  it('legacy 出口发出的每一条都先交给 shadow 旁听(app 接收器截走的也算)', async () => {
    const shadow = vi.fn()
    const send = makeSendAssistantText({ sendMessage: vi.fn(async () => ({ msgId: 'm' })), log: vi.fn(), capture: () => true, shadow })!
    await send('c1', '你好')
    expect(shadow).toHaveBeenCalledWith('c1', '你好')
  })
})

describe('makeSendNotice — 系统通知与 agent 的话分家(spec §4.3)', () => {
  it('app 接收器开着 ⇒ 截给 app(通知在 app 里也要看得见)', async () => {
    const sendMessage = vi.fn(async () => ({ msgId: 'm' }))
    const notice = makeSendNotice({ sendMessage, log: vi.fn(), capture: () => true })!
    await notice('c1', '登录过期了')
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('不进打猎旁听,也不进 shadow 旁听;日志是 NOTICE_SENT', async () => {
    const observe = vi.fn()
    const shadow = vi.fn()
    const log = vi.fn()
    const notice = makeSendNotice({ sendMessage: vi.fn(async () => ({ msgId: 'm9' })), log, observe, shadow })!
    await notice('c1', '刚刚脑子卡了一下')
    expect(observe).not.toHaveBeenCalled()
    expect(shadow).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith('NOTICE_SENT', expect.stringContaining('msgId=m9'))
  })

  it('发送失败 ⇒ NOTICE_FAIL', async () => {
    const log = vi.fn()
    const notice = makeSendNotice({ sendMessage: vi.fn(async () => ({ msgId: '', error: 'errcode=-2' })), log })!
    await notice('c1', 'x')
    expect(log).toHaveBeenCalledWith('NOTICE_FAIL', expect.stringContaining('errcode=-2'))
  })
})
