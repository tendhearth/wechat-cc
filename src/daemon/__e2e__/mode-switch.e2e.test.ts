// Tier 3 / T3.1 — slash-command mode switching (/cc, /codex, /both, /chat).
// User sends a slash command; the inbound pipeline's mode middleware
// updates conversationStore for that chat. The next non-command inbound
// must route through the new mode without needing an explicit re-set.
//
// What this catches:
//   - mode-commands.ts not wired into the pipeline
//   - mode change committed to store but not visible to coordinator on
//     the very next inbound (caching / debounce regression)
//   - status reply lost when slash command executes
import { describe, it, expect } from 'vitest'
import { startTestDaemon } from './harness'

describe('e2e: /codex slash command flips chat mode for subsequent messages', () => {
  it('default solo+claude → /codex → next msg dispatched to codex', async () => {
    const dispatched: Array<'claude' | 'codex'> = []
    const daemon = await startTestDaemon({
      dangerously: true,
      // Default: no `modes` preset, so chat1 starts at solo+claude.
      claudeScript: {
        async onDispatch(_text) {
          dispatched.push('claude')
          return { toolCalls: [], finalText: 'claude reply' }
        },
      },
      codexScript: {
        async onDispatch(_text) {
          dispatched.push('codex')
          return { toolCalls: [], finalText: 'codex reply' }
        },
      },
    })
    try {
      // Step 1: send /codex — mode middleware should flip + ack with status text.
      daemon.sendText('chat1', '/codex')
      await daemon.waitForOutbound(
        msgs => msgs.some(m => m.endpoint === 'sendmessage' && m.chatId === 'chat1'),
        5000,
      )
      // Slash command itself shouldn't dispatch to either provider.
      expect(dispatched).toEqual([])

      // Step 2: send a real message — must route to codex now.
      daemon.sendText('chat1', '你好', { createTimeMs: Date.now() + 1000 })
      await daemon.waitForOutbound(
        msgs => msgs.filter(m => m.endpoint === 'sendmessage' && m.chatId === 'chat1').length >= 2,
        8000,
      )
      expect(dispatched).toEqual(['codex'])
    } finally {
      await daemon.stop()
    }
  })
})
