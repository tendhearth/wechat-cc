import { describe, it, expect } from 'vitest'
import { PHONE_SAY_MAX_CHARS } from '@wechat-cc/protocol'
import { composeTooLong } from './compose'

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
