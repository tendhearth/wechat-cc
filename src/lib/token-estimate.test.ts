import { describe, expect, it } from 'vitest'
import { estimateTokens } from './token-estimate'

describe('estimateTokens', () => {
  it('empty → 0', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('pure ASCII ≈ chars/3.8', () => {
    // 38 ASCII chars → 10 tokens
    expect(estimateTokens('a'.repeat(38))).toBe(10)
  })

  it('CJK counts one token per char', () => {
    expect(estimateTokens('记忆整理待办提醒')).toBe(8)
  })

  it('mixed text adds both parts', () => {
    // 8 CJK + 19 ASCII → 8 + ceil(19/3.8)=5 → 13
    expect(estimateTokens('记忆整理待办提醒' + 'b'.repeat(19))).toBe(13)
  })

  it('CJK punctuation counts as CJK', () => {
    expect(estimateTokens('。，「」')).toBe(4)
  })
})
