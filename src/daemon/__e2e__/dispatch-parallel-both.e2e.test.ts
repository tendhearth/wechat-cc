// Tier 2 / T2.2 — parallel mode (`/both`). Both providers receive the
// same inbound concurrently; coordinator forwards each provider's plain
// text reply with a `[Display]` prefix so the user can tell who said what.
//
// What this catches:
//   - parallelProviders fan-out broken (one provider not dispatched)
//   - [Display] prefix forwarding regression
//   - Promise.allSettled error handling drops a provider's reply silently
//   - mode persistence loses parallel kind
import { describe, it, expect } from 'vitest'
import { startTestDaemon } from './harness'

describe('e2e: parallel mode → both providers dispatch + both replies forwarded with [Display] prefix', () => {
  it('user "你好" with mode=parallel → 2 outbound msgs, one per provider', async () => {
    const dispatchedTo: string[] = []
    const daemon = await startTestDaemon({
      dangerously: true,
      modes: { chat1: { kind: 'parallel' } },
      claudeScript: {
        async onDispatch(_text) {
          dispatchedTo.push('claude')
          return { toolCalls: [], finalText: 'claude 你好' }
        },
      },
      codexScript: {
        async onDispatch(_text) {
          dispatchedTo.push('codex')
          return { toolCalls: [], finalText: 'codex 你好' }
        },
      },
    })
    try {
      daemon.sendText('chat1', '你好')
      // Wait until BOTH providers' replies land in outbox.
      const replies = await daemon.waitForOutbound(
        msgs => msgs.filter(m => m.endpoint === 'sendmessage' && m.chatId === 'chat1').length >= 2,
        8000,
      )
      const sendmessages = replies.filter(r => r.endpoint === 'sendmessage' && r.chatId === 'chat1')
      const texts = sendmessages.map(r => r.text ?? '')
      expect(texts.some(t => t.includes('[Claude]') && t.includes('claude 你好'))).toBe(true)
      expect(texts.some(t => t.includes('[Codex]') && t.includes('codex 你好'))).toBe(true)
      // Both providers received the inbound (order doesn't matter).
      expect(new Set(dispatchedTo)).toEqual(new Set(['claude', 'codex']))
    } finally {
      await daemon.stop()
    }
  })
})
