import { describe, it, expect } from 'vitest'
import { validateNickname, NICKNAME_MAX_LEN } from './nickname'

describe('validateNickname', () => {
  it('accepts CJK / letters / digits / space / _ / - within the length cap', () => {
    expect(validateNickname('丸子')).toBeNull()
    expect(validateNickname('Nate')).toBeNull()
    expect(validateNickname('张 三')).toBeNull()
    expect(validateNickname('user_1-A')).toBeNull()
    expect(validateNickname('x'.repeat(NICKNAME_MAX_LEN))).toBeNull()
  })

  it('rejects empty', () => {
    expect(validateNickname('')).toBe('empty')
  })

  it('rejects over the length cap', () => {
    expect(validateNickname('x'.repeat(NICKNAME_MAX_LEN + 1))).toBe('too_long')
  })

  it('rejects disallowed characters (markup / punctuation / control)', () => {
    expect(validateNickname('<script>')).toBe('bad_charset')
    expect(validateNickname('a@b')).toBe('bad_charset')
    expect(validateNickname('emoji😀')).toBe('bad_charset')
    expect(validateNickname('line\nbreak')).toBe('bad_charset')
  })
})
