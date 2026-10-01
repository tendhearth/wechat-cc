import { describe, it, expect } from 'vitest'
import { PHONE_SAY_MAX_CHARS } from '@wechat-cc/protocol'
import { composeOutcome, composeOutcomeDot, composeTooLong } from './compose'

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
