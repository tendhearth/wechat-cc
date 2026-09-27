import { describe, it, expect } from 'vitest'
import { parseBoolValue, parseTimeoutMsFlag, parseBudgetUsdFlag, parseCountFlag } from './flags'

describe('flags(从 cli.ts 搬出的纯函数,行为逐字不变)', () => {
  it('parseBoolValue 认 true/1/yes/on 与 false/0/no/off,其它 undefined', () => {
    expect(parseBoolValue('yes')).toBe(true)
    expect(parseBoolValue('off')).toBe(false)
    expect(parseBoolValue('maybe')).toBeUndefined()
    expect(parseBoolValue(undefined)).toBeUndefined()
  })
  it('parseTimeoutMsFlag:空 ⇒ ok 无值;正数 ⇒ ok 带值;0/负/NaN ⇒ 错', () => {
    expect(parseTimeoutMsFlag(undefined)).toEqual({ ok: true })
    expect(parseTimeoutMsFlag('')).toEqual({ ok: true })
    expect(parseTimeoutMsFlag('1500')).toEqual({ ok: true, value: 1500 })
    expect(parseTimeoutMsFlag('0')).toEqual({ ok: false, error: 'invalid value: 0 (expected a positive number of milliseconds)' })
  })
  it('parseBudgetUsdFlag 同形,单位是 dollars', () => {
    expect(parseBudgetUsdFlag('2.5')).toEqual({ ok: true, value: 2.5 })
    expect(parseBudgetUsdFlag('-1')).toEqual({ ok: false, error: 'invalid value: -1 (expected a positive number of dollars)' })
  })
  it('parseCountFlag 要整数且 ≥ min', () => {
    expect(parseCountFlag('3', 1)).toEqual({ ok: true, value: 3 })
    expect(parseCountFlag('2.5', 1)).toEqual({ ok: false, error: 'invalid value: 2.5 (expected an integer ≥ 1)' })
    expect(parseCountFlag('0', 1)).toEqual({ ok: false, error: 'invalid value: 0 (expected an integer ≥ 1)' })
  })
})
