// Tier 3 / T3.2 — how the agent's words reach WeChat, end to end.
//
// 回复交付(spec 2026-10-03-reply-delivery §4.10)之后五家执行者都走 daemon:一轮最后写下的话就是回复,
// daemon 送达 —— 这里钉「最后的话 → 恰好一条 sendmessage」。旧路(reply 工具说话 + FALLBACK_REPLY)连同回滚
// 开关在 D3 删掉了,钉它的两条旧契约(回滚到 legacy 调 / 不调 reply)也一起删了。
import { describe, it, expect } from 'vitest'
import { startTestDaemon } from './harness'

const settle = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('e2e: the final text is the reply (daemon delivery, the default for every provider)', () => {
  it('agent writes its answer (no reply tool) → exactly ONE sendmessage with that text, nothing after it', async () => {
    const daemon = await startTestDaemon({
      dangerously: true,
      claudeScript: { async onDispatch() { return { toolCalls: [], finalText: '最后的话就是回复' } } },
    })
    try {
      daemon.sendText('chat1', 'hi', { contextToken: 'ctx-d' })
      await daemon.waitForReplyTo('chat1', 8000)
      // 留一点时间:如果还有第二条(旁白 / 双发),它会在这段时间里到。
      await settle(800)
      const sendmessages = daemon.ilink.outbox().filter(r => r.endpoint === 'sendmessage' && r.chatId === 'chat1')
      expect(sendmessages).toHaveLength(1)
      expect(sendmessages[0]?.text).toContain('最后的话就是回复')
    } finally {
      await daemon.stop()
    }
  })
})
