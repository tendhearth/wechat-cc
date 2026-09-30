import { describe, it, expect } from 'vitest'
import { palette } from './tokens'

describe('设计 token', () => {
  it('浅深两套键一致', () => {
    expect(Object.keys(palette.dark).sort()).toEqual(Object.keys(palette.light).sort())
  })
  it('所有值是 #rrggbb', () => {
    for (const s of [palette.light, palette.dark]) for (const [k, v] of Object.entries(s)) expect(v, k).toMatch(k === 'scrim' ? /^rgba\(/ : /^#[0-9a-f]{6}$/)
  })
  it('钉住 Codex 稿色值', () => {
    expect(palette.light.bg).toBe('#faf8f3')
    expect(palette.light.primary).toBe('#58654c')
    expect(palette.dark.bg).toBe('#221f1b')
  })
})
