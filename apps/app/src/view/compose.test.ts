import { describe, it, expect } from 'vitest'
import { PHONE_SAY_MAX_CHARS } from '@wechat-cc/protocol'
import { composeOutcome, composeOutcomeDot, composeOutcomeText, composeTooLong } from './compose'

// daemon 两处上限相同(20 000):说一句 POST /m/api/matter/say;交办新事项 parseEntryInput → ENTRY_LIMITS.text(invalid_text)。
describe('composeTooLong', () => {
  it('说一句:上限以内 ⇒ false;超过 ⇒ true', () => {
    expect(composeTooLong('ok')).toBe(false)
    expect(composeTooLong('x'.repeat(PHONE_SAY_MAX_CHARS))).toBe(false)
    expect(composeTooLong('x'.repeat(PHONE_SAY_MAX_CHARS + 1))).toBe(true)
  })
  it('交办新事项:同一上限(20 000),超过同样拦下', () => {
    expect(composeTooLong('帮'.repeat(20_000))).toBe(false)
    expect(composeTooLong('帮'.repeat(20_001))).toBe(true)
  })
})

describe('composeOutcome:提交失败码 ⇒ 页内提示', () => {
  it('uncertain / busy(CC 这一轮在跑)/ revoked 各有各的;其余 ⇒ failed', () => {
    expect(composeOutcome('uncertain')).toBe('uncertain')
    expect(composeOutcome('busy')).toBe('ccBusy')
    expect(composeOutcome('revoked')).toBe('revoked')
    for (const e of ['offline', 'unknown', 'invalid', 'not_found']) expect(composeOutcome(e)).toBe('failed')
  })
})

describe('交办结果那一行的状态点(状态色只上点)', () => {
  it('没送到 / 太长 / 已解除配对 ⇒ 红;不确定 ⇒ 灰(不知道);还在忙 ⇒ 琥珀', () => {
    expect(composeOutcomeDot('failed')).toBe('bad')
    expect(composeOutcomeDot('tooLong')).toBe('bad')
    expect(composeOutcomeDot('revoked')).toBe('bad')
    expect(composeOutcomeDot('uncertain')).toBe('unknown')
    expect(composeOutcomeDot('busy')).toBe('warn')
    expect(composeOutcomeDot('ccBusy')).toBe('warn')
  })
})

describe('接着做电脑会话的失败码(spec D11)', () => {
  it('五个码各有各的页内提示;忙 / 额度 ⇒ 琥珀(等一等),没装 / 文件夹不在 ⇒ 红', () => {
    expect([composeOutcome('session_busy'), composeOutcome('folder_busy'), composeOutcome('provider_missing'), composeOutcome('folder_missing'), composeOutcome('quota')])
      .toEqual(['sessionBusy', 'folderBusy', 'providerMissing', 'folderMissing', 'quota'])
    expect([composeOutcomeDot('sessionBusy'), composeOutcomeDot('folderBusy'), composeOutcomeDot('quota')]).toEqual(['warn', 'warn', 'warn'])
    expect([composeOutcomeDot('providerMissing'), composeOutcomeDot('folderMissing')]).toEqual(['bad', 'bad'])
  })
  it('第一句时会话刚变 / 没内容 ⇒ 各说各的,不说「没送到」(裁决 R5)', () => {
    expect([composeOutcome('session_changed'), composeOutcome('session_empty')]).toEqual(['sessionChanged', 'sessionEmpty'])
    expect([composeOutcomeDot('sessionChanged'), composeOutcomeDot('sessionEmpty')]).toEqual(['warn', 'bad'])
    expect(composeOutcomeText('sessionChanged', 'zh-Hans', 'claude')).toBe('这个会话刚有新动静，再看一眼再接。')
    expect(composeOutcomeText('sessionEmpty', 'en', null)).toBe('There’s nothing in this session to continue.')
  })
  it('composeOutcomeText:一句话;没装执行者时有名字说名字,没有就说「这个执行者」;旧的几种不变', () => {
    expect(composeOutcomeText('providerMissing', 'zh-Hans', 'claude')).toBe('电脑上没装 Claude Code')
    expect(composeOutcomeText('providerMissing', 'zh-Hans', null)).toBe('电脑上没装这个执行者')
    expect(composeOutcomeText('sessionBusy', 'zh-Hans', null)).toBe('这个会话正在电脑上跑，停下后才能接着做')
    expect(composeOutcomeText('ccBusy', 'zh-Hans', null)).toBe('CC 还在忙这件事，等这一轮做完再说。')
    expect(composeOutcomeText('revoked', 'zh-Hans', null)).toBe('这台手机已不再配对')
    expect(composeOutcomeText('failed', 'en', null)).toBe('This didn’t reach your computer. Please try again in a moment.')
  })
})
