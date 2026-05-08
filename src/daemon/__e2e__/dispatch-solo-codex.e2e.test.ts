// Tier 2 / T2.1 — solo codex text inbound. Mirror of inbound-reply.e2e
// but routed to the codex provider, exercising the codex SDK fake's
// item.completed event path and codex-agent-provider's session lifecycle.
//
// What this catches:
//   - codex provider not registered when binary detection passes
//   - codex SDK iterable shape changes break the provider
//   - mode persistence ignores codex selection
import { describe, it, expect } from 'vitest'
import { startTestDaemon } from './harness'

describe('e2e: solo codex text inbound → codex dispatch + outbound reply', () => {
  it('user "你好" with mode=solo+codex routes through codex provider', async () => {
    let codexDispatched: string | null = null
    let claudeWasCalled = false
    const daemon = await startTestDaemon({
      dangerously: true,
      modes: { chat1: { kind: 'solo', provider: 'codex' } },
      claudeScript: {
        async onDispatch(_text) {
          claudeWasCalled = true
          return { toolCalls: [], finalText: '' }
        },
      },
      codexScript: {
        async onDispatch(text) {
          codexDispatched = text
          return { toolCalls: [], finalText: '你好（codex）' }
        },
      },
    })
    try {
      daemon.sendText('chat1', '你好')
      const replies = await daemon.waitForReplyTo('chat1', 8000)
      expect(replies[0]?.endpoint).toBe('sendmessage')
      expect(replies[0]?.text).toContain('你好（codex）')
      // Routing assertion — Claude must NOT be invoked when mode=solo+codex.
      expect(claudeWasCalled).toBe(false)
      expect(codexDispatched).toContain('你好')
      expect(codexDispatched).toContain('chat_id="chat1"')
    } finally {
      await daemon.stop()
    }
  })
})
