// Tier 2 / T2.3 — primary_tool mode (`/cc + codex`). Claude is the
// primary; codex is exposed to claude as a `delegate_codex` tool but
// is not directly dispatched on inbound. From the user's POV one
// reply lands in the chat, prefixed by the primary's display name.
//
// What this catches:
//   - mode persistence loses the `primary` field
//   - coordinator accidentally dispatches the secondary directly
//     (would produce 2 replies — wrong)
//   - delegate-mcp child fails to register (covered indirectly: claude
//     dispatch text references delegate availability via system prompt)
import { describe, it, expect } from 'vitest'
import { startTestDaemon } from './harness'

describe('e2e: primary_tool mode → primary dispatched, secondary only as delegate', () => {
  it('user "你好" with mode=primary_tool(claude+codex) → only claude dispatched', async () => {
    let claudeDispatched = false
    let codexDispatched = false
    const daemon = await startTestDaemon({
      dangerously: true,
      modes: { chat1: { kind: 'primary_tool', primary: 'claude', secondary: 'codex' } },
      claudeScript: {
        async onDispatch(_text) {
          claudeDispatched = true
          return { toolCalls: [], finalText: 'primary claude 答' }
        },
      },
      codexScript: {
        async onDispatch(_text) {
          codexDispatched = true
          return { toolCalls: [], finalText: '(secondary should not be dispatched directly)' }
        },
      },
    })
    try {
      daemon.sendText('chat1', '你好')
      const replies = await daemon.waitForReplyTo('chat1', 8000)
      const sendmessages = replies.filter(r => r.endpoint === 'sendmessage' && r.chatId === 'chat1')
      expect(sendmessages.length).toBe(1)
      expect(sendmessages[0]?.text).toContain('primary claude 答')
      expect(claudeDispatched).toBe(true)
      // Codex must NOT be dispatched directly — primary_tool routes only
      // to the primary; secondary is an MCP delegate tool the primary
      // can choose to invoke (and doesn't, in this test).
      expect(codexDispatched).toBe(false)
    } finally {
      await daemon.stop()
    }
  })
})
