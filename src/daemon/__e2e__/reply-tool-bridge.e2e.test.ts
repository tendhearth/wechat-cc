// Tier 3 / T3.2 — reply tool bridge vs fallback path.
//
// Two contracts to pin:
//   1. When the agent calls the wechat `reply` tool, the daemon's
//      internal-api delivers the outbound and the coordinator does
//      NOT additionally fall back to forwarding assistant text.
//      (Otherwise the user sees the reply twice.)
//   2. When the agent does NOT call reply, the fallback path fires
//      and forwards assistant text. (Already covered by inbound-reply
//      e2e but re-asserted here so a regression in `replyToolCalled`
//      detection breaks both tests, not just the fallback one.)
import { describe, it, expect } from 'vitest'
import { startTestDaemon } from './harness'

describe('e2e: reply tool produces exactly one outbound; fallback does NOT double-fire', () => {
  it('agent calls reply → ONE sendmessage with the reply tool input text', async () => {
    const daemon = await startTestDaemon({
      dangerously: true,
      claudeScript: {
        async onDispatch(_text) {
          return {
            toolCalls: [{ name: 'reply', input: { chat_id: 'chat1', text: '工具回复' } }],
            // assistantText is non-empty, but should NOT appear in outbox
            // because replyToolCalled=true triggers skip-fallback.
            finalText: '这段不该被发出',
          }
        },
      },
    })
    try {
      daemon.sendText('chat1', 'hi')
      // Wait for the bridge POST → daemon internal-api → ilink sendmessage.
      const replies = await daemon.waitForReplyTo('chat1', 8000)
      const sendmessages = replies.filter(r => r.endpoint === 'sendmessage' && r.chatId === 'chat1')
      // Exactly one — bridge produced the reply, fallback skipped.
      expect(sendmessages).toHaveLength(1)
      expect(sendmessages[0]?.text).toContain('工具回复')
      // Fallback assistant text must NOT have leaked through.
      expect(sendmessages[0]?.text).not.toContain('这段不该被发出')
    } finally {
      await daemon.stop()
    }
  })

  it('agent does NOT call reply → fallback forwards assistant text', async () => {
    const daemon = await startTestDaemon({
      dangerously: true,
      claudeScript: {
        async onDispatch(_text) {
          return { toolCalls: [], finalText: 'fallback 路径回复' }
        },
      },
    })
    try {
      daemon.sendText('chat1', 'hi', { contextToken: 'ctx-x' })
      const replies = await daemon.waitForReplyTo('chat1', 8000)
      const sendmessages = replies.filter(r => r.endpoint === 'sendmessage' && r.chatId === 'chat1')
      expect(sendmessages.length).toBeGreaterThan(0)
      expect(sendmessages[0]?.text).toContain('fallback 路径回复')
    } finally {
      await daemon.stop()
    }
  })
})
