import { describe, it, expect } from 'vitest'
import { parseIntroCommand } from './intro-command'
describe('parseIntroCommand', () => {
  it('认识 / 同意 / 不了 + 2–8 位 hex 引用;可带 #;两边空白', () => {
    expect(parseIntroCommand('认识 ab12')).toEqual({ kind: 'request', ref: 'ab12' })
    expect(parseIntroCommand(' 同意 #ff00aa ')).toEqual({ kind: 'accept', ref: 'ff00aa' })
    expect(parseIntroCommand('不了 c0ffee00')).toEqual({ kind: 'decline', ref: 'c0ffee00' })
  })
  it('不是这三个词 / 引用不是 hex / 太长 / 没引用 → null', () => {
    for (const t of ['认识 你', '认识', '同意 zz', '不了 123456789', '派 ab12', '认识 ab12 更多']) expect(parseIntroCommand(t)).toBe(null)
  })
})
