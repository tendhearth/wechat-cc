// Tier 1 / T1.3 — solo claude image inbound regression.
//
// This is the baseline that proves the image pipeline works end-to-end
// (RawUpdate type=2 → mw-attachments → formatInbound → speaker prompt
// containing [image:/abs/path]). Solo path was always intended to handle
// images correctly; chatroom T1.2 builds on the same plumbing to verify
// the 2026-05-08 regression fix didn't drop on the floor.
//
// What this test catches:
//   - poll-loop fails to parse type=2 image items
//   - mw-attachments materialization stub broken in fakes
//   - formatInbound stops emitting [image:/path] for materialized attachments
//   - solo dispatch swallows attachments out of the prompt
import { describe, it, expect } from 'vitest'
import { startTestDaemon } from './harness'

describe('e2e: solo claude image inbound → speaker sees [image:/path]', () => {
  it('image RawUpdate materializes to inbox/ and reaches speaker via formatInbound envelope', async () => {
    let dispatchedText: string | null = null
    const daemon = await startTestDaemon({
      dangerously: true,
      claudeScript: {
        async onDispatch(text) {
          dispatchedText = text
          return { toolCalls: [], finalText: '收到图片了' }
        },
      },
    })
    try {
      daemon.sendImage('chat1')
      const replies = await daemon.waitForReplyTo('chat1', 8000)
      expect(replies[0]?.endpoint).toBe('sendmessage')
      // Speaker prompt must carry the image marker so it can Read/Bash the file.
      expect(dispatchedText).toMatch(/\[image:[^\]]+\.(jpg|jpeg|png|bin)\]/)
      expect(dispatchedText).toContain('chat_id="chat1"')
    } finally {
      await daemon.stop()
    }
  })
})
