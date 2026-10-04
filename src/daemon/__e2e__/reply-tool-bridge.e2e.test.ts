// Tier 3 / T3.2 — how the agent's words reach WeChat, end to end.
//
// 回复交付第 5 步(2026-10-03,spec 2026-10-03-reply-delivery §4.10 / §5.7)之后五家执行者都走 daemon:
// 一轮最后写下的话就是回复,daemon 送达 —— 这里钉「最后的话 → 恰好一条 sendmessage」。legacy(reply 工具说话 +
// FALLBACK_REPLY)只剩回滚开关(agent-config `reply_delivery`)那条路,保留到收尾那一步删掉之前,所以两条旧契约
// 也还在,只是改成在回滚开关下跑:
//   1. 回滚到 legacy、agent 调 reply ⇒ 只有 reply 那一条,协调器不再补发文字(否则主人收到两遍)。
//   2. 回滚到 legacy、agent 不调 reply ⇒ FALLBACK 把文字发出去。
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

describe('e2e: rollback to legacy (agent-config reply_delivery) — reply tool produces exactly one outbound; fallback does NOT double-fire', () => {
  it('legacy: agent calls reply → ONE sendmessage with the reply tool input text', async () => {
    const daemon = await startTestDaemon({
      dangerously: true,
      agentConfig: { reply_delivery: { claude: 'legacy' } },
      claudeScript: {
        async onDispatch(_text) {
          return {
            toolCalls: [{ name: 'reply', input: { chat_id: 'chat1', text: '工具回复' } }],
            // assistantText is non-empty, but should NOT appear in outbox
            // because replyToolCalled=true triggers skip-fallback.
            finalText: '这段不该被发出',
          }
        },
      },
    })
    try {
      daemon.sendText('chat1', 'hi')
      await daemon.waitForReplyTo('chat1', 8000)
      await settle(800)
      const sendmessages = daemon.ilink.outbox().filter(r => r.endpoint === 'sendmessage' && r.chatId === 'chat1')
      // Exactly one — bridge produced the reply, fallback skipped.
      expect(sendmessages).toHaveLength(1)
      expect(sendmessages[0]?.text).toContain('工具回复')
      expect(sendmessages[0]?.text).not.toContain('这段不该被发出')
    } finally {
      await daemon.stop()
    }
  })

  it('legacy: agent does NOT call reply → fallback forwards assistant text', async () => {
    const daemon = await startTestDaemon({
      dangerously: true,
      agentConfig: { reply_delivery: { claude: 'legacy' } },
      claudeScript: {
        async onDispatch(_text) {
          return { toolCalls: [], finalText: 'fallback 路径回复' }
        },
      },
    })
    try {
      daemon.sendText('chat1', 'hi', { contextToken: 'ctx-x' })
      const replies = await daemon.waitForReplyTo('chat1', 8000)
      const sendmessages = replies.filter(r => r.endpoint === 'sendmessage' && r.chatId === 'chat1')
      expect(sendmessages.length).toBeGreaterThan(0)
      expect(sendmessages[0]?.text).toContain('fallback 路径回复')
    } finally {
      await daemon.stop()
    }
  })
})
