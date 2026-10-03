import { describe, it, expect, afterEach } from 'vitest'
import { applyReplyDeliveryConfig } from './reply-delivery-config'
import { replyDeliveryFor, setReplyDeliveryOverrides } from '../../core/capability-matrix'

describe('applyReplyDeliveryConfig — 开机时把 agent-config 的 reply_delivery 装上', () => {
  afterEach(() => setReplyDeliveryOverrides(undefined))

  it('装上覆盖并逐家记一行 BOOT 日志', () => {
    const logs: string[] = []
    applyReplyDeliveryConfig({ reply_delivery: { openai: 'legacy' } }, (t, l) => logs.push(`[${t}] ${l}`))
    expect(replyDeliveryFor('openai')).toBe('legacy')
    expect(logs.some(l => l.includes('reply_delivery') && l.includes('openai=legacy'))).toBe(true)
  })

  it('没配 ⇒ 清掉上一次的覆盖(回到能力表默认)', () => {
    setReplyDeliveryOverrides({ openai: 'legacy' })
    applyReplyDeliveryConfig({}, () => {})
    expect(replyDeliveryFor('gemini')).toBe('legacy')
    expect(replyDeliveryFor('openai')).not.toBe('legacy')
  })
})
