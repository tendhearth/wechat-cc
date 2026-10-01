import { describe, it, expect } from 'vitest'
import { color, typeScale, fontWeight, contrast, renderTokensCss } from './index'

const HEX = /^#[0-9a-f]{6}$/
describe('design tokens', () => {
  it('pins the owner-approved palette (spec §2.1)', () => {
    expect(color.paper).toBe('#faf7f2')
    expect(color.accent).toBe('#4f6b4f')
    expect(color.ink).toBe('#2a2622')
    expect(color.inkSoft).toBe('#70665d')
    expect(color.unknown).toBe(color.inkSoft)
    for (const [k, v] of Object.entries(color)) if (!['glow', 'scrim'].includes(k)) expect(v, k).toMatch(HEX)
  })
  it('text meets AA on every surface; dots meet 3:1', () => {
    for (const bg of [color.paper, color.rail, color.ground]) {
      expect(contrast(color.ink, bg)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(color.inkSoft, bg)).toBeGreaterThanOrEqual(4.5)
    }
    expect(contrast(color.onAccent, color.accent)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(color.accent, color.paper)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(color.bad, color.paper)).toBeGreaterThanOrEqual(4.5)
    for (const d of [color.ok, color.warn, color.bad, color.unknown]) expect(contrast(d, color.paper)).toBeGreaterThanOrEqual(3)
  })
  it('only two weights; hierarchy by size', () => {
    expect(Object.values(fontWeight).sort()).toEqual([400, 500])
    expect(typeScale.display.desktop).toBeGreaterThan(typeScale.item.desktop)
    expect(typeScale.display.phone).toBeGreaterThan(typeScale.item.phone)
  })
  it('renders css custom properties for every token and declares light only', () => {
    const css = renderTokensCss()
    expect(css).toContain('--th-paper: #faf7f2;')
    expect(css).toContain('--th-size-display: 48px;')
    expect(css).toContain('--th-lh-display: 1.15;')
    expect(css).toContain('--th-radius-control: 28px;')
    expect(css).toContain('color-scheme: light;')
    expect(css).not.toMatch(/prefers-color-scheme/)
  })
  it('no CJK medium weight: only the Latin-only wordmark uses medium', () => {
    const medium = Object.entries(typeScale).filter(([, v]) => v.weight === 'medium').map(([k]) => k)
    expect(medium).toEqual(['wordmark'])
  })
})
