import { describe, it, expect } from 'vitest'
import { phoneFont, fontGate, plainText } from './type'

describe('phoneFont', () => {
  it('中文界面用 Noto Serif SC,英文界面用 TH Serif 4(Source Serif 4 的子集)', () => {
    expect(phoneFont('body', 'zh-Hans').fontFamily).toBe('NotoSerifSC-Regular')
    expect(phoneFont('body', 'en').fontFamily).toBe('THSerif4-Regular')
  })
  it('用户内容一律 Noto Serif SC(英文界面里的中文标题不落到无衬线)', () => {
    expect(phoneFont('item', 'en', 'user').fontFamily).toBe('NotoSerifSC-Regular')
  })
  it('中等字重靠换家族名,不靠 fontWeight;中文只有 Regular(裁决 D1)', () => {
    expect(phoneFont('wordmark', 'en').fontFamily).toBe('THSerif4-Medium')
    // 没有 CJK Medium:中文界面 / 用户内容里即使是 medium 角色也落到 Regular
    expect(phoneFont('wordmark', 'zh-Hans').fontFamily).toBe('NotoSerifSC-Regular')
    expect(phoneFont('wordmark', 'en', 'user').fontFamily).toBe('NotoSerifSC-Regular')
    expect(phoneFont('title', 'zh-Hans').fontFamily).toBe('NotoSerifSC-Regular')
    expect(Object.keys(phoneFont('title', 'zh-Hans'))).not.toContain('fontWeight')
    expect(Object.keys(phoneFont('wordmark', 'en'))).not.toContain('fontWeight')
  })
  it('字号与行高来自共用 token(手机列)', () => {
    expect(phoneFont('display', 'zh-Hans')).toMatchObject({ fontSize: 36, lineHeight: Math.round(36 * 1.15) })
    expect(phoneFont('meta', 'en').letterSpacing).toBeCloseTo(14 * 0.04)
  })
  it('用户内容若一个中文字都没有 ⇒ 拉丁衬线(弯引号 ’ “ ” 不落到中文全角字形)', () => {
    expect(phoneFont('item', 'en', 'user', 'Plan next week’s trip').fontFamily).toBe('THSerif4-Regular')
    expect(phoneFont('item', 'zh-Hans', 'user', 'It’s colder today.').fontFamily).toBe('THSerif4-Regular')
    expect(phoneFont('item', 'en', 'user', '整理下周出差安排').fontFamily).toBe('NotoSerifSC-Regular')
    expect(phoneFont('item', 'en', 'user', 'Let’s 改一下').fontFamily).toBe('NotoSerifSC-Regular')
    // 没给文本(不知道内容)⇒ 照旧 Noto(安全:中文永不落到无衬线)
    expect(phoneFont('item', 'en', 'user').fontFamily).toBe('NotoSerifSC-Regular')
  })
  it('中文界面文案里的拉丁弯引号(没有中文字)同样走拉丁衬线', () => {
    expect(phoneFont('body', 'zh-Hans', 'ui', 'Tendhearth’s').fontFamily).toBe('THSerif4-Regular')
    expect(phoneFont('body', 'zh-Hans', 'ui', '设置').fontFamily).toBe('NotoSerifSC-Regular')
  })
  it('代码用等宽', () => { expect(phoneFont('code', 'en').fontFamily).toBe('mono') })
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
