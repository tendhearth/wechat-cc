import { describe, it, expect } from 'vitest'
import en from './en'
import zh from './zh-Hans'
import { pickLang, t } from './index'

describe('文案表', () => {
  it('两份语言的键完全一致', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })
  it('没有空字符串', () => {
    for (const [k, v] of [...Object.entries(en), ...Object.entries(zh)]) expect(v.trim(), k).not.toBe('')
  })
  it('pickLang:中文系 ⇒ zh-Hans,其它(含法语、空)⇒ en', () => {
    expect(pickLang(['zh-Hans-CN'])).toBe('zh-Hans')
    expect(pickLang(['zh-TW'])).toBe('zh-Hans')
    expect(pickLang(['fr-FR', 'zh-CN'])).toBe('en')
    expect(pickLang([])).toBe('en')
  })
  it('插值', () => {
    expect(t('en', 'now.needsYouCount', { n: 2 })).toContain('2')
    expect(t('zh-Hans', 'now.needsYouCount', { n: 2 })).toContain('2')
  })
  it('隐私文案说明命令文本会发给便宜模型服务商', () => {
    expect(en['settings.privacyBody']).toMatch(/cheap|model provider/i)
    expect(zh['settings.privacyBody']).toContain('便宜模型')
  })
})
