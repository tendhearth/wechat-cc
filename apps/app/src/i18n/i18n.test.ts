import { describe, it, expect } from 'vitest'
import en from './en'
import zh from './zh-Hans'
import { pickLang, t, tCount } from './index'

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
    expect(tCount('en', 'now.waiting', 2)).toBe('2 things waiting for you')
    expect(tCount('en', 'now.waiting', 1)).toBe('1 thing waiting for you')
    expect(tCount('zh-Hans', 'now.waiting', 2)).toBe('2 件事等你')
  })
  it('隐私文案:命令文本与任务进展事件从主人自己的电脑发给那里配置的便宜模型服务商;其余只在手机与电脑之间加密传输', () => {
    const e = en['settings.privacyBody']
    expect(e).toMatch(/command text/i)
    expect(e).toMatch(/progress/i)
    expect(e).toMatch(/from your (own )?computer/i)
    expect(e).toMatch(/cheap model provider/i)
    expect(e).toMatch(/Now, progress(,)? (or|and) approval/i)
    expect(e).toMatch(/encrypted/i)
    const z = zh['settings.privacyBody']
    expect(z).toContain('命令文本')
    expect(z).toContain('进展')
    expect(z).toContain('你自己的电脑')
    expect(z).toContain('便宜模型')
    expect(z).toContain('此刻')
    expect(z).toContain('批准')
    expect(z).toContain('加密')
  })
  it('原始命令多出来的行数:英文单复数', () => {
    expect(tCount('en', 'approval.moreLines', 1)).toBe('(+1 more line)')
    expect(tCount('en', 'approval.moreLines', 4)).toBe('(+4 more lines)')
    expect(tCount('zh-Hans', 'approval.moreLines', 4)).toBe('(还有 4 行)')
  })
  it('新增短词:离线、多选上限、版权', () => {
    expect(en['common.computerOfflineShort']).toBe('offline')
    expect(zh['common.computerOfflineShort']).toBe('离线')
    expect(t('en', 'approval.maxChoices', { n: 8 })).toBe('Up to 8 choices')
    expect(t('zh-Hans', 'approval.maxChoices', { n: 8 })).toBe('最多选 8 项')
    expect(en['settings.copyright']).toBe('© Nate Gu & Co LLC')
    expect(zh['settings.copyright']).toBe('© Nate Gu & Co LLC')
  })
})
