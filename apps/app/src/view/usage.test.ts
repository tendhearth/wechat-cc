import { describe, expect, it } from 'vitest'
import { compactTokens, usageLine } from './usage'

const U = { turns: 3, input: 48_210, output: 6_120, cacheRead: null, cacheWrite: null, reasoning: null, costUsd: null }

describe('用了多少额度', () => {
  it('一行合计;没报 ⇒ 不报,从不写 0', () => {
    expect(usageLine(U, 'zh-Hans')).toBe('这件事用了 3 轮 · 输入 4.8 万 / 输出 6120 token')
    expect(usageLine(U, 'en')).toBe('Used 3 rounds · input 48.2k / output 6.1k tokens')
    expect(usageLine({ ...U, output: null }, 'zh-Hans')).toBe('这件事用了 3 轮 · 输入 4.8 万 / 输出 不报 token')
    expect(usageLine({ ...U, input: null, output: null }, 'zh-Hans')).toBe('这件事用了 3 轮 · 这家不报用量')
    expect(usageLine({ ...U, turns: 1 }, 'en')).toBe('Used 1 round · input 48.2k / output 6.1k tokens')
    expect(usageLine({ ...U, input: 0 }, 'zh-Hans')).toContain('输入 0 /')   // 真报了 0 才写 0
  })
  it('没有 usage(老电脑 / 一轮都没报)⇒ 不画', () => {
    expect(usageLine(undefined, 'zh-Hans')).toBeNull()
    expect(usageLine({ ...U, turns: 0 }, 'zh-Hans')).toBeNull()
  })
  it('数字收短', () => {
    expect(compactTokens(9_999, 'zh-Hans')).toBe('9999'); expect(compactTokens(20_000, 'zh-Hans')).toBe('2 万')
    expect(compactTokens(999, 'en')).toBe('999'); expect(compactTokens(1_000, 'en')).toBe('1k'); expect(compactTokens(2_500_000, 'en')).toBe('2.5M')
  })
})
