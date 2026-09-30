import { describe, it, expect } from 'vitest'
import { PHONE_SAY_MAX_CHARS } from '@wechat-cc/protocol'
import { sayTooLong } from './compose'

describe('sayTooLong(与 daemon POST /m/api/matter/say 的 20 000 字上限一致)', () => {
  it('上限以内 ⇒ false;超过 ⇒ true', () => {
    expect(sayTooLong('ok')).toBe(false)
    expect(sayTooLong('x'.repeat(PHONE_SAY_MAX_CHARS))).toBe(false)
    expect(sayTooLong('x'.repeat(PHONE_SAY_MAX_CHARS + 1))).toBe(true)
  })
})
