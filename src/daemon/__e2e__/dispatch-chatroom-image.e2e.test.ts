// Tier 1 / T1.2 — combined regression for the two 2026-05-08 chatroom
// metadata-drop bugs:
//   1. f7acca0 — [image:/path] dropped by moderator paraphrase
//   2. b69973f — [chat_id:xxx] dropped by moderator paraphrase
//
// Both originally shared a root cause (haiku-4-5 generated a NEW prompt
// rather than passing the user's <wechat> envelope through). The LLM
// moderator was deleted in a4101ca and replaced by the structural
// conductor (chatroom-conductor.ts), which embeds deps.format(msg)
// (the <wechat> envelope, [image:/path] included) directly as `question`
// in every beat's prompt — but that refactor dropped the [chat_id:xxx]
// bracket re-injection, reintroducing bug 2. This test pins both markers
// in the conductor's shared opening prompt.
import { describe, it, expect } from 'vitest'
import { startTestDaemon } from './harness'

describe('e2e: chatroom mode image inbound → speaker prompt carries chat_id + [image:/path]', () => {
  it('user sends image → claude speaker dispatch contains both [chat_id:chat1] and [image:/...]', async () => {
    const claudeDispatchedTexts: string[] = []
    let modCall = 0
    const daemon = await startTestDaemon({
      dangerously: true,
      modes: { chat1: { kind: 'chatroom' } },
      // The LLM moderator that used to paraphrase per-speaker prompts was
      // deleted in a4101ca — the conductor (chatroom-conductor.ts) now
      // builds one shared opening/rebuttal prompt structurally for every
      // beat, so this script only feeds the convergence-check (beat ②b)
      // and verdict (beat ③) evals, neither of which shapes the beat ①
      // prompt asserted on below.
      moderatorScript: {
        async onEval(_prompt) {
          modCall++
          return modCall === 1
            ? JSON.stringify({ converged: true })
            : '🎯 done'
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
      // Both injections must be present in the conductor's shared opening prompt.
      expect(dispatched).toContain('[chat_id:chat1]')
      expect(dispatched).toMatch(/\[image:[^\]]+\.jpg\]/)
    } finally {
      await daemon.stop()
    }
  })
})
