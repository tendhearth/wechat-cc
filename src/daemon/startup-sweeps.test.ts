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
