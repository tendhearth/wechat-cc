import { describe, it, expect } from 'vitest'
import { PAIR_CHECK_ALPHABET, PAIR_CHECK_RE, pairCheckCode } from './pair-check'

describe('pairCheckCode(配对核对码;桌面与手机共用)', () => {
  it('固定向量(v2 派生定下就别改:改了桌面与手机、新旧版本对不上)', () => {
    expect(pairCheckCode(`r${'a'.repeat(26)}`)).toBe('USZ-YAY')
    expect(pairCheckCode(`r${'b'.repeat(26)}`)).toBe('VH9-L6H')
    expect(pairCheckCode(`t${'0'.repeat(36)}`)).toBe('J6E-HY3')
  })
  it('6 个字符(30 位)显示成 XXX-XXX,只用不易看错的字母表(没有 0 O 1 I)', () => {
    expect(PAIR_CHECK_ALPHABET).toHaveLength(32)
    expect(new Set(PAIR_CHECK_ALPHABET).size).toBe(32)
    expect(PAIR_CHECK_ALPHABET).not.toMatch(/[01IO]/)
    expect(PAIR_CHECK_RE.test('USZ-YAY')).toBe(true)
    expect(PAIR_CHECK_RE.test('USZYAY')).toBe(false)
    expect(PAIR_CHECK_RE.test('FHWL')).toBe(false)
    for (let i = 0; i < 200; i++) expect(pairCheckCode(`r${i.toString(32).padStart(26, 'a')}`)).toMatch(PAIR_CHECK_RE)
  })
  it('不同的 id ⇒ 几乎总是不同的码', () => {
    const codes = new Set<string>()
    for (let i = 0; i < 200; i++) codes.add(pairCheckCode(`r${i.toString(32).padStart(26, 'a')}`))
    expect(codes.size).toBe(200)
  })
})
