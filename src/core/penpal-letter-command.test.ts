import { describe, it, expect } from 'vitest'
import { parseLetterCommand } from './penpal-letter-command'

describe('parseLetterCommand', () => {
  it('parses "回信 <channel> <text>" and tolerates a leading # on the channel', () => {
    expect(parseLetterCommand('回信 c1 你好啊')).toEqual({ channel: 'c1', text: '你好啊' })
    expect(parseLetterCommand('回信 #c1 你好啊')).toEqual({ channel: 'c1', text: '你好啊' })
  })
  it('preserves a multi-word / multi-line body', () => {
    expect(parseLetterCommand('回信 c1 你好 最近还好吗')).toEqual({ channel: 'c1', text: '你好 最近还好吗' })
    expect(parseLetterCommand('回信 c1 第一行\n第二行')).toEqual({ channel: 'c1', text: '第一行\n第二行' })
  })
  it('returns null for bare 回信, 回信 with no body, and non-command text', () => {
    expect(parseLetterCommand('回信')).toBeNull()
    expect(parseLetterCommand('回信 c1')).toBeNull()
    expect(parseLetterCommand('今天天气不错')).toBeNull()
  })
})
