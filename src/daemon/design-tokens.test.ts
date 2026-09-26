/**
 * 手机端网页统一设计风格(spec 2026-09-26-web-design-unify):单一色板 apps/mobile/src/tokens.css。
 * 这里守两件事:旧「暖棕手绘」四色不再出现在任何主人会看到的网页里;中继壳页(单独部署、不能引用 tokens)
 * 用到的每个颜色都在 tokens 里。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { MOBILE_TOKENS_CSS, mobilePhoneHtml, MOBILE_BOOTSTRAP_HTML } from './mobile-page'
import { pageHtml, EXPIRED_HTML } from './settings-panel-html'

const LEGACY = ['#f5ead8', '#5a3f2d', '#8b5e3c', '#b0563a', 'rgba(176,86,58', 'rgba(89,63,44', '#d8c6ae']
const hexes = (s: string) => new Set((s.toLowerCase().match(/#[0-9a-f]{6}\b/g) ?? []))

describe('one design language across the owner-facing web pages', () => {
  it('tokens define the palette, radii and fonts', () => {
    for (const v of ['--paper:#f9f7f1', '--ink:#483f35', '--soft:#7e7365', '--accent:#735b3e', '--line:#e5dfd3', '--r-m:14px', '--hand:'])
      expect(MOBILE_TOKENS_CSS.replace(/\s+/g, '')).toContain(v.replace(/\s+/g, ''))
  })
  it.each([
    ['/m', () => mobilePhoneHtml('dTOKEN', null)],
    ['/set', () => pageHtml('tTOKEN')],
    ['expired', () => EXPIRED_HTML],
    ['/m bootstrap', () => MOBILE_BOOTSTRAP_HTML],
  ])('%s uses the tokens and none of the legacy colours', (_name, render) => {
    const html = render().toLowerCase()
    for (const c of LEGACY) expect(html, c).not.toContain(c)
    expect(html).toContain('--paper:#f9f7f1')
  })
  it('the relay shell page only uses token colours', () => {
    const shell = readFileSync(new URL('../../relay/pset.html', import.meta.url), 'utf8')
    const allowed = hexes(MOBILE_TOKENS_CSS)
    for (const c of hexes(shell)) expect(allowed, c).toContain(c)
    for (const c of LEGACY) expect(shell.toLowerCase(), c).not.toContain(c)
  })
  it('phone page sources outside tokens.css use no literal hex colours', () => {
    const dir = new URL('../../apps/mobile/src/', import.meta.url)
    for (const f of readdirSync(dir).filter(n => /\.(css|html|js)$/.test(n) && n !== 'tokens.css')) {
      const src = readFileSync(new URL(f, dir), 'utf8')
      expect(src.match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![0-9a-fA-F])/g) ?? [], f).toEqual([])
    }
  })
})
