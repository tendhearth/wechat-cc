import { describe, it, expect } from 'vitest'
import { phoneFont, fontGate, plainText } from './type'

describe('phoneFont', () => {
  it('中英文界面正文走系统字', () => {
    expect(phoneFont('body', { text: '设置' }).fontFamily).toBe(undefined)
    expect(phoneFont('body', { text: 'Settings' }).fontFamily).toBe(undefined)
  })
  it('用户内容走系统字，即使没传原文', () => {
    expect(phoneFont('item', { content: 'user' }).fontFamily).toBe(undefined)
  })
  it('字标保留原字，普通标题的 medium 用 500 表达', () => {
    expect(phoneFont('wordmark', { text: 'Tendhearth' }).fontFamily).toBe('THSerif4-Medium')
    expect(phoneFont('wordmark', { text: 'CC' }).fontFamily).toBe('THSerif4-Medium')
    expect(phoneFont('wordmark', { text: '设置' }).fontFamily).toBe(undefined)
    expect(phoneFont('wordmark', { content: 'user', text: 'Tendhearth' }).fontFamily).toBe(undefined)
    expect(phoneFont('title', { text: '设置' }).fontFamily).toBe(undefined)
    expect(Object.keys(phoneFont('title', { text: '设置' }))).not.toContain('fontWeight')
    expect(Object.keys(phoneFont('wordmark', { text: 'Tendhearth' }))).not.toContain('fontWeight')
    expect(phoneFont('wordmark', { text: '设置' })).toMatchObject({ fontWeight: '500' })
    expect(phoneFont('wordmark', { text: 'Settings' })).toMatchObject({ fontWeight: '500' })
  })
  it('字号与行高来自共用 token(手机列)', () => {
    expect(phoneFont('display')).toMatchObject({ fontSize: 36, lineHeight: Math.round(36 * 1.15) })
    expect(phoneFont('meta').letterSpacing).toBeCloseTo(14 * 0.04)
  })
  it('用户内容无论语言、混排或弯引号都走系统字', () => {
    expect(phoneFont('item', { content: 'user', text: 'Plan next week’s trip' }).fontFamily).toBe(undefined)
    expect(phoneFont('item', { content: 'user', text: 'It’s colder today.' }).fontFamily).toBe(undefined)
    expect(phoneFont('item', { content: 'user', text: '整理下周出差安排' }).fontFamily).toBe(undefined)
    expect(phoneFont('item', { content: 'user', text: 'Let’s 改一下' }).fontFamily).toBe(undefined)
    expect(phoneFont('item', { content: 'user' }).fontFamily).toBe(undefined)
  })
  it('界面文案中的拉丁弯引号和中文都走系统字', () => {
    expect(phoneFont('body', { content: 'ui', text: 'Tendhearth’s' }).fontFamily).toBe(undefined)
    expect(phoneFont('body', { content: 'ui', text: '设置' }).fontFamily).toBe(undefined)
  })
  it('CC 的字按角色放大，行高跟着放开', () => {
    expect(phoneFont('body', { voice: 'cc', content: 'user', text: '我回来啦' })).toEqual({
      fontFamily: 'THPenHand-Regular', fontSize: 19.5, lineHeight: 31, letterSpacing: 0,
    })
    expect(phoneFont('small', { voice: 'cc', text: 'Back home' })).toEqual({
      fontFamily: 'THPenHand-Regular', fontSize: 16, lineHeight: 24, letterSpacing: 0,
    })
  })
  it('代码用等宽，CC 的代码也是', () => {
    expect(phoneFont('code').fontFamily).toBe('mono')
    expect(phoneFont('code', { voice: 'cc', content: 'user', text: 'ls' })).toEqual(phoneFont('code'))
  })
})

describe('plainText', () => {
  it('字符串 / 数字 / 数组拼起来;有元素节点 ⇒ 不知道', () => {
    expect(plainText('a')).toBe('a')
    expect(plainText(['✓ ', 'Plan', 3, null, false])).toBe('✓ Plan3')
    expect(plainText(['a', { type: 'View' }])).toBeUndefined()
  })
})

describe('fontGate', () => {
  it('加载完或出错都放行;只有既没好也没错才等', () => {
    expect(fontGate(false, null)).toBe('wait')
    expect(fontGate(true, null)).toBe('go')
    expect(fontGate(false, new Error('x'))).toBe('go')
  })
})
