import { describe, it, expect } from 'vitest'
import { phoneFont, fontGate } from './type'

describe('phoneFont', () => {
  it('界面和用户内容都走系统字', () => {
    for (const role of ['display', 'title', 'item', 'body', 'bubble', 'meta', 'small', 'caption'] as const) {
      expect(phoneFont(role).fontFamily).toBe(undefined)
      expect(phoneFont(role, { content: 'user' }).fontFamily).toBe(undefined)
    }
  })
  it('顶栏标题(medium)用 500 表达,不靠字体家族;别的角色不带字重', () => {
    expect(phoneFont('wordmark')).toMatchObject({ fontFamily: undefined, fontWeight: '500' })
    expect(phoneFont('wordmark', { content: 'user' })).toMatchObject({ fontFamily: undefined, fontWeight: '500' })
    expect(Object.keys(phoneFont('title'))).not.toContain('fontWeight')
    expect(Object.keys(phoneFont('body'))).not.toContain('fontWeight')
  })
  it('品牌的字标留原来的衬线字,只在界面文案上生效', () => {
    expect(phoneFont('display', { voice: 'brand' }).fontFamily).toBe('THSerif4-Regular')
    expect(phoneFont('wordmark', { voice: 'brand' }).fontFamily).toBe('THSerif4-Medium')
    expect(Object.keys(phoneFont('wordmark', { voice: 'brand' }))).not.toContain('fontWeight')
    expect(phoneFont('display', { voice: 'brand' }).fontSize).toBe(36)
    expect(phoneFont('display', { voice: 'brand', content: 'user' }).fontFamily).toBe(undefined)
  })
  it('字号与行高来自共用 token(手机列)', () => {
    expect(phoneFont('display')).toMatchObject({ fontSize: 36, lineHeight: Math.round(36 * 1.15) })
    expect(phoneFont('meta').letterSpacing).toBeCloseTo(14 * 0.04)
  })
  it('CC 的字放大 1.125 倍(看起来和正文一样大),行高跟着放开', () => {
    expect(phoneFont('body', { voice: 'cc', content: 'user' })).toEqual({
      fontFamily: 'THPenHand-Regular', fontSize: 18, lineHeight: 29, letterSpacing: 0,
    })
    expect(phoneFont('small', { voice: 'cc' })).toEqual({
      fontFamily: 'THPenHand-Regular', fontSize: 14.5, lineHeight: 22, letterSpacing: 0,
    })
    expect(Object.keys(phoneFont('wordmark', { voice: 'cc' }))).not.toContain('fontWeight')
  })
  it('代码用等宽，CC 的代码也是', () => {
    expect(phoneFont('code').fontFamily).toBe('mono')
    expect(phoneFont('code', { voice: 'cc', content: 'user' })).toEqual(phoneFont('code'))
  })
})

describe('fontGate', () => {
  it('加载完或出错都放行;只有既没好也没错才等', () => {
    expect(fontGate(false, null)).toBe('wait')
    expect(fontGate(true, null)).toBe('go')
    expect(fontGate(false, new Error('x'))).toBe('go')
  })
})
