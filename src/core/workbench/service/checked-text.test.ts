import { describe, it, expect } from 'vitest'
import { checkedText } from './checked-text'
import type { Attachment } from '../attachments'

const att = { id: 'a', size: 1 } as unknown as Attachment

describe('checkedText', () => {
  it('trim 后返回;非字符串 / 空且无附件 / 超 20000 ⇒ invalid_text', () => {
    expect(checkedText('  做点事 ')).toBe('做点事')
    expect(() => checkedText(1 as never)).toThrow('invalid_text')
    expect(() => checkedText('   ')).toThrow('invalid_text')
    expect(() => checkedText('x'.repeat(20_001))).toThrow('invalid_text')
  })
  it('有附件时允许空文本(只发材料)', () => {
    expect(checkedText('', [att])).toBe('')
  })
})
