import { describe, expect, it } from 'vitest'
import { makePermissionAnswer } from './permission-answer'

describe('makePermissionAnswer — the one consumer of a WeChat answer to a pending card', () => {
  it('keeps ordinary quotes and summarizes marked quotes even if the decision handler throws', () => {
    const logs: string[] = []
    const consume = makePermissionAnswer({
      ilink: { handlePermissionReply: text => { if (text === 'y') throw Error('test decision failure'); return false } },
      log: (_tag, line) => logs.push(line),
    })
    const ordinary = { text: 'ordinary quote' }
    const msg = { chatId: 'owner', text: 'follow-up', quote: ordinary }
    expect(consume(msg)).toBe(false)
    expect(msg.quote).toBe(ordinary)
    const marked = { chatId: 'owner', text: 'y', quote: { text: 'Fixture\n〔请求 1234567890abcdef〕\nprivate fixture' } }
    expect(() => consume(marked)).toThrow('test decision failure')
    expect(marked.quote.text).toBe('（引用了一张待批卡 · 〔请求 1234567890abcdef〕）')
    expect(logs).toEqual([])
  })

  it('consumed ⇒ true + one audit line; not consumed (not an answer, or the pending is gone) ⇒ false, no line', () => {
    const lines: string[] = []
    const calls: unknown[][] = []
    let pending = true
    const consume = makePermissionAnswer({
      ilink: { handlePermissionReply: (text, from, quoted) => { calls.push([text, from, quoted]); if (text !== 'y' || !pending) return false; pending = false; return true } },
      log: (t, l) => lines.push(`${t} ${l}`),
    })
    expect(consume({ chatId: 'owner', text: 'y', quote: { text: '卡片' } })).toBe(true)
    expect(calls[0]).toEqual(['y', 'owner', '卡片'])
    expect(lines).toEqual(['PERMISSION consumed reply from chat=owner'])
    expect(consume({ chatId: 'owner', text: 'y' })).toBe(false)   // 已经没有待批了(桌面拍过 / 过期)
    expect(consume({ chatId: 'owner' })).toBe(false)
    expect(calls[2]).toEqual(['', 'owner', undefined]) // 没有文字(图片 / 语音)⇒ 按空串问,不编一句出来
    expect(lines).toHaveLength(1)
  })
})
