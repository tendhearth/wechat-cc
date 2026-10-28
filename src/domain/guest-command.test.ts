import { describe, it, expect } from 'vitest'
import { parseGuestCommand } from './guest-command'

describe('parseGuestCommand', () => {
  it('允许 <6 digits> → allow', () => {
    expect(parseGuestCommand('允许 483921')).toEqual({ kind: 'allow', code: '483921' })
  })

  it('拒绝 <6 digits> → deny', () => {
    expect(parseGuestCommand('拒绝 483921')).toEqual({ kind: 'deny', code: '483921' })
  })

  it('tolerates surrounding + inner whitespace', () => {
    expect(parseGuestCommand('  允许   483921 ')).toEqual({ kind: 'allow', code: '483921' })
    expect(parseGuestCommand('  拒绝   483921 ')).toEqual({ kind: 'deny', code: '483921' })
  })

  it('bare 邀请码 → invite', () => {
    expect(parseGuestCommand('邀请码')).toEqual({ kind: 'invite' })
    expect(parseGuestCommand('  邀请码  ')).toEqual({ kind: 'invite' })
  })

  it('bare 待批准 → pending', () => {
    expect(parseGuestCommand('待批准')).toEqual({ kind: 'pending' })
    expect(parseGuestCommand('  待批准  ')).toEqual({ kind: 'pending' })
  })

  it('exact 6-digit codes required — 5 or 7 digits do not match', () => {
    expect(parseGuestCommand('允许 12345')).toBeNull()
    expect(parseGuestCommand('允许 1234567')).toBeNull()
    expect(parseGuestCommand('拒绝 12345')).toBeNull()
    expect(parseGuestCommand('拒绝 1234567')).toBeNull()
  })

  it('deterministic exact match only — extra surrounding text does not match (no fuzzing)', () => {
    expect(parseGuestCommand('请允许 483921 吧')).toBeNull()
    expect(parseGuestCommand('允许 483921 吧')).toBeNull()
    expect(parseGuestCommand('麻烦邀请码')).toBeNull()
    expect(parseGuestCommand('待批准一下')).toBeNull()
  })

  it('unrelated text → null', () => {
    expect(parseGuestCommand('你好')).toBeNull()
    expect(parseGuestCommand('')).toBeNull()
    expect(parseGuestCommand('配对 483921')).toBeNull()
  })

  it('allow/deny require a code — bare 允许/拒绝 do not match', () => {
    expect(parseGuestCommand('允许')).toBeNull()
    expect(parseGuestCommand('拒绝')).toBeNull()
  })
})
