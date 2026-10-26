import { describe, expect, it } from 'vitest'
import { makePermissionAnswer } from './permission-answer'

describe('makePermissionAnswer — the one consumer of a WeChat answer to a pending card', () => {
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
    expect(lines).toHaveLength(1)
  })
})
