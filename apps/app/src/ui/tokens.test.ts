import { describe, it, expect } from 'vitest'
import { color } from '@wechat-cc/design-tokens'
import { palette } from './tokens'

describe('设计 token', () => {
  it('只有一套色板,就是共用包里那一份(没有深色)', () => {
    expect(palette).toBe(color)
    expect('dark' in (palette as object)).toBe(false)
  })
})
