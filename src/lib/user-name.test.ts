import { describe, expect, it } from 'vitest'
import { normalizeUserName } from './user-name'

describe('normalizeUserName', () => {
  it('strips 叫我/请叫我-style prefixes down to the name itself', () => {
    expect(normalizeUserName('叫我大人')).toBe('大人')
    expect(normalizeUserName('请叫我大人')).toBe('大人')
    expect(normalizeUserName('你可以叫我老王')).toBe('老王')
    expect(normalizeUserName('喊我阿强就行')).toBe('阿强')
    expect(normalizeUserName('我叫顾时瑞')).toBe('顾时瑞')
    expect(normalizeUserName('我是小明')).toBe('小明')
    expect(normalizeUserName('以后叫我大人吧')).toBe('大人')
  })

  it('strips trailing 就行/吧/哦 particles and punctuation', () => {
    expect(normalizeUserName('大人就行')).toBe('大人')
    expect(normalizeUserName('大人吧')).toBe('大人')
    expect(normalizeUserName('大人。')).toBe('大人')
  })

  it('strips surrounding quotes and whitespace', () => {
    expect(normalizeUserName('「大人」')).toBe('大人')
    expect(normalizeUserName(' “大人” ')).toBe('大人')
  })

  it('keeps a plain name untouched', () => {
    expect(normalizeUserName('大人')).toBe('大人')
    expect(normalizeUserName('Nate')).toBe('Nate')
    expect(normalizeUserName('王工')).toBe('王工')
  })

  it('falls back to the trimmed original when stripping would leave nothing or something absurd', () => {
    expect(normalizeUserName('叫我')).toBe('叫我')
    expect(normalizeUserName('')).toBe('')
    // stripping must not fire mid-word on a long sentence that merely contains a verb
    expect(normalizeUserName('大家都叫我老王,但你随意')).toBe('大家都叫我老王,但你随意')
  })
})
