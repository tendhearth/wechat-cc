import { describe, expect, it, vi } from 'vitest'
import { restartNoticeSender } from './startup-sweeps'

describe('重启通知经 CC 开口那道门(第三批 3a)', () => {
  it('交给门就算办完:说出去了 / 进了待说队列都回 {} —— notifyStartup 不再重试,不往队列里塞好几份', async () => {
    for (const said of [true, false]) {
      const tell = vi.fn(async () => said)
      const logs: string[] = []
      const send = restartNoticeSender({ speech: { tell }, log: (_t, l) => logs.push(l) })
      expect(await send('owner', 'CC 刚才重启了')).toEqual({})
      expect(tell).toHaveBeenCalledWith('restart_notice', 'owner', 'CC 刚才重启了')
      expect(logs.some(l => l.includes('pending queue'))).toBe(!said)
    }
  })
  it('门没接 ⇒ 不发、记一行(不退回直接发)', async () => {
    const logs: string[] = []
    expect(await restartNoticeSender({ log: (_t, l) => logs.push(l) })('owner', 'x')).toEqual({})
    expect(logs[0]).toContain('speech policy not wired')
  })
})

describe('重启通知按对话一个一个进门(整合者评审)', () => {
  it('两个收件人、一个送到一个没送到 ⇒ 只有没送到的那个进待说队列', async () => {
    const { makeSpeechPolicy } = await import('./speech/policy')
    const { makePendingNotices } = await import('./speech/pending-notices')
    const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path')
    const pending = makePendingNotices({ stateDir: mkdtempSync(join(tmpdir(), 'restart-')), log: () => {} })
    const outbound = {
      appDeliverable: () => false, canDeliver: () => true, sendOnce: async () => ({ ok: true }),
      open: (chatId: string) => ({ sendText: async () => (chatId === 'admin-b' ? { msgId: '', error: 'down' } : { msgId: 'm' }), channel: () => 'wechat' as const, textOnly: () => false, sendAttachment: async () => false, sendSticker: async () => false, finish: () => {} }),
    }
    const speech = makeSpeechPolicy({ care: () => 'low', quietEndsAt: () => null, outbound, log: () => {}, pending })
    const send = restartNoticeSender({ speech, log: () => {} })
    await send('admin-a', 'CC 刚才重启了')
    await send('admin-b', 'CC 刚才重启了')
    expect(pending.groups().map(g => g.chatId)).toEqual(['admin-b'])
  })
})
