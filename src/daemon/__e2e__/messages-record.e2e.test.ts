// Task 3 — inbound messages recording e2e.
// Boots the full daemon, sends one text inbound, then verifies the
// messages table captured it (direction='in', correct text).
// Outbound recording is Task 4 — not asserted here.
import { describe, it, expect } from 'vitest'
import { startTestDaemon } from './harness'
import { openWechatDb } from '../../lib/db'
import { makeMessagesStore } from '../messages/store'

describe('e2e: mw-messages records inbound into messages table', () => {
  it('sends "你好" and finds 1 row direction=in in messages', async () => {
    const daemon = await startTestDaemon({
      dangerously: true,
      claudeScript: {
        async onDispatch(_text) {
          return { toolCalls: [], finalText: '好的' }
        },
      },
    })
    try {
      daemon.sendText('chat1', '你好')
      // Wait for the reply to confirm the full pipeline ran (including mw-messages)
      await daemon.waitForReplyTo('chat1', 8000)

      const db = openWechatDb(daemon.stateDir)
      const store = makeMessagesStore(db)
      const rows = await store.listRange('chat1', { limit: 20 })
      const inbound = rows.filter(r => r.direction === 'in')
      expect(inbound.length).toBe(1)
      expect(inbound[0]?.text).toBe('你好')
      expect(inbound[0]?.kind).toBe('text')
      expect(inbound[0]?.source).toBe('live')
      db.close()
    } finally {
      await daemon.stop()
    }
  })
})
