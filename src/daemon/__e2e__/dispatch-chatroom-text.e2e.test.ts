// Tier 1 / T1.1 — chatroom text inbound + moderator-driven dispatch.
//
// Regression coverage for the 2026-05-08 chat_id-drop bug (commit b69973f).
// Solo / parallel modes dispatch format(msg) directly so the speaker sees
// the <wechat chat_id="..."> envelope. Chatroom funnels through haiku-4-5
// which paraphrases the user message and silently strips identifiers.
// The fix injects [chat_id:xxx] into every dispatched prompt — this test
// pins that behavior so a future moderator rewrite can't quietly regress.
//
// What this catches:
//   - moderator decision parsing breaks
//   - speaker session never sees the originating chat_id
//   - [Display] prefix forwarding stops working
//   - reply path forwards instead of plain-text path
import { describe, it, expect } from 'vitest'
import { startTestDaemon } from './harness'

describe('e2e: chatroom mode text inbound → speaker prompt carries chat_id', () => {
  it('user "你好" → moderator picks claude → dispatch contains [chat_id:chat1]', async () => {
    const claudeDispatchedTexts: string[] = []
    let modCall = 0
    const daemon = await startTestDaemon({
      dangerously: true,
      modes: { chat1: { kind: 'chatroom' } },
      moderatorScript: {
        async onEval(_prompt) {
          // Round 1: claude opens. Round 2: end.
          modCall++
          if (modCall === 1) {
            return JSON.stringify({
              action: 'continue', speaker: 'claude',
              prompt: '简短打个招呼然后 @codex 抛球', reasoning: 'open',
            })
          }
          return JSON.stringify({ action: 'end', reasoning: 'done' })
        },
      },
      claudeScript: {
        async onDispatch(text) {
          claudeDispatchedTexts.push(text)
          // Plain text — chatroom protocol; coordinator forwards via [Display]
          return { toolCalls: [], finalText: '@user 你好。@codex 你说什么' }
        },
      },
      codexScript: {
        async onDispatch(_text) {
          return { toolCalls: [], finalText: '(codex never asked in this test)' }
        },
      },
    })
    try {
      daemon.sendText('chat1', '你好')
      const replies = await daemon.waitForReplyTo('chat1', 8000)
      const sendmessages = replies.filter(r => r.endpoint === 'sendmessage')
      expect(sendmessages.length).toBeGreaterThan(0)
      // Coordinator forwards speaker's plain text with [Claude] display prefix.
      expect(sendmessages[0]?.text).toContain('[Claude]')
      // Most important: speaker prompt MUST carry chat_id so memory_*/set_user_name
      // tools can route correctly. This is the regression guard.
      expect(claudeDispatchedTexts[0]).toContain('[chat_id:chat1]')
    } finally {
      await daemon.stop()
    }
  })
})
