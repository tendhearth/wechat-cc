// 桌面样式守卫(spec 2026-10-01 §6.1)。
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = __dirname
const walk = (d: string, out: string[] = []): string[] => {
  for (const n of readdirSync(d)) { const f = join(d, n); statSync(f).isDirectory() ? (n === 'vendor' ? 0 : walk(f, out)) : out.push(f) }
  return out
}
const CSS = walk(ROOT).filter(f => f.endsWith('.css') && !f.endsWith('tokens.css'))
const rel = (f: string) => relative(ROOT, f)
const hexCount = (s: string) => (s.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(\s*\d/g) ?? []).length
/** 三块主界面零字面色值;其余按棘轮。Task 12 / 13 只许把数字往下改。 */
export const HEX_BUDGET: Record<string, number> = {
  // 2026-10-01 实测基线(Task 8,机械替换旧色板之后)。companion-window / animation-lab 不在换皮范围(spec §8)。
  'animation-lab.css': 32,
  'cc-life.css': 0,
  'cc-page-art.css': 5,
  'cc-surfaces.css': 23,
  'companion-window.css': 16,
  'fonts.css': 0,
  'postcard-album.css': 23,
  'styles.css': 648,
}
/** Task 10 加 cc-life.css、cc-now.css;Task 12 加工作台三份(styles/workbench*.css、styles/task-entry.css);converse.css 新建即零。 */
const ZERO_HEX: string[] = ['cc-life.css', 'cc-now.css', 'styles/workbench.css', 'styles/workbench-attention.css', 'styles/task-entry.css', 'styles/converse.css']

describe('desktop design style', () => {
  it('no dark mode', () => { for (const f of CSS) expect(readFileSync(f, 'utf8'), rel(f)).not.toMatch(/prefers-color-scheme:\s*dark/) })
  it('font-weight is 400 / 500 / normal only', () => {
    for (const f of CSS) expect(readFileSync(f, 'utf8').match(/font-weight:\s*(?!400\b|500\b|normal\b|var\()[^;}\s]+/g) ?? [], rel(f)).toEqual([])
    // 简写里的字重(`font: 600 11px/1.5 …`)同样只许 400 / 500 —— 裁决 E3。
    for (const f of CSS) expect(readFileSync(f, 'utf8').match(/\bfont:\s*(?!400\b|500\b)(\d{3}|bold|bolder)\b/g) ?? [], rel(f)).toEqual([])
  })
  it('fonts are local; no runtime CDN', () => {
    const html = readFileSync(join(ROOT, 'index.html'), 'utf8')
    for (const s of [html, ...CSS.map(f => readFileSync(f, 'utf8'))]) expect(s).not.toMatch(/fonts\.(googleapis|gstatic)\.com/)
    expect(html.indexOf('tokens.css')).toBeGreaterThan(-1)
    expect(html.indexOf('tokens.css')).toBeLessThan(html.indexOf('styles.css'))
  })
  it('body text is serif', () => {
    const css = readFileSync(join(ROOT, 'styles.css'), 'utf8')
    expect(css).toMatch(/--sans:\s*var\(--th-font-serif\)/)
    expect(css).not.toMatch(/font-family:\s*"Geist"/)
  })
  it('workbench status chips are dot + text (no tinted chip backgrounds)', () => {
    const css = readFileSync(join(ROOT, 'styles/workbench.css'), 'utf8')
    expect(css.match(/background(-color)?:\s*var\(--(green|amber|rouge)-soft\)/g) ?? []).toEqual([])
    expect(css).toMatch(/\.wb-status::before/)
    for (const f of ['styles/workbench.css', 'styles/workbench-attention.css', 'styles/task-entry.css', 'styles/converse.css']) expect(readFileSync(join(ROOT, f), 'utf8'), f).not.toMatch(/box-shadow:\s*(?!none)/)
  })
  it('literal colours: ratchet', () => {
    for (const f of CSS) {
      const r = rel(f)
      const budget = ZERO_HEX.includes(r) ? 0 : HEX_BUDGET[r]
      if (budget === undefined) continue
      expect(hexCount(readFileSync(f, 'utf8')), r).toBeLessThanOrEqual(budget)
    }
  })
})
