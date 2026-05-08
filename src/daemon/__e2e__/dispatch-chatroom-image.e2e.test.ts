// Tier 1 / T1.2 — combined regression for the two 2026-05-08 chatroom
// metadata-drop bugs:
//   1. f7acca0 — [image:/path] dropped by moderator paraphrase
//   2. b69973f — [chat_id:xxx] dropped by moderator paraphrase
//
// Both share a root cause (haiku-4-5 generates a NEW prompt rather than
// passing the user's <wechat> envelope through) and are fixed by
// injecting structural metadata into dispatchedPrompt at the coordinator
// layer. This test pins both behaviors at once.
import { describe, it, expect } from 'vitest'
import { startTestDaemon } from './harness'

describe('e2e: chatroom mode image inbound → speaker prompt carries chat_id + [image:/path]', () => {
  it('user sends image → claude speaker dispatch contains both [chat_id:chat1] and [image:/...]', async () => {
    const claudeDispatchedTexts: string[] = []
    let modCall = 0
    const daemon = await startTestDaemon({
      dangerously: true,
      modes: { chat1: { kind: 'chatroom' } },
      moderatorScript: {
        async onEval(_prompt) {
          modCall++
          // Round 1: claude. Round 2: end. Crucially, the moderator's
          // generated prompt does NOT include the [image:...] marker
          // (simulating real haiku paraphrasing) — the coordinator's
          // injection is what makes the speaker see the file path.
          if (modCall === 1) {
            return JSON.stringify({
              action: 'continue', speaker: 'claude',
              prompt: '描述一下用户发的内容', reasoning: 'open',
            })
          }
          return JSON.stringify({ action: 'end', reasoning: 'done' })
        },
      },
      claudeScript: {
        async onDispatch(text) {
          claudeDispatchedTexts.push(text)
          return { toolCalls: [], finalText: '@user 看到了' }
        },
      },
      codexScript: { async onDispatch(_t) { return { toolCalls: [], finalText: '' } } },
    })
    try {
      daemon.sendImage('chat1')
      await daemon.waitForReplyTo('chat1', 8000)
      expect(claudeDispatchedTexts.length).toBeGreaterThan(0)
      const dispatched = claudeDispatchedTexts[0]!
      // Both injections must be present even though the moderator stripped them.
      expect(dispatched).toContain('[chat_id:chat1]')
      expect(dispatched).toMatch(/\[image:[^\]]+\.jpg\]/)
      // The moderator-paraphrased prompt body should still be there.
      expect(dispatched).toContain('描述一下用户发的内容')
    } finally {
      await daemon.stop()
    }
  })
})
