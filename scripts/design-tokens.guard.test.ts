// 桌面 tokens.css 是生成物:与 packages/design-tokens 渲染结果逐字一致;手机色板就是同一个对象。
import { describe, it, expect } from 'vitest'
import { readFileSync, statSync, existsSync, readdirSync } from 'node:fs'
import { renderTokensCss } from '../packages/design-tokens/src/index'

describe('one set of design tokens across desktop and phone', () => {
  it('apps/desktop/src/tokens.css is up to date (run: bun scripts/build-design-tokens.ts)', () => {
    expect(readFileSync(new URL('../apps/desktop/src/tokens.css', import.meta.url), 'utf8')).toBe(renderTokensCss())
  })
  // Task 3 把手机 tokens.ts 改成再导出 color 后,恢复为 it 并加回 import { color } / { palette }。
  it.todo('phone palette is the shared palette (no mirror to drift): expect(palette).toBe(color)')
})

// ---- bundled fonts (spec §3;裁决 D1:Noto Serif SC 只有 Regular;预算每端 15 MB) ----
const APP_FONTS = ['NotoSerifSC-Regular.ttf', 'SourceSerif4-Regular.ttf', 'SourceSerif4-Medium.ttf']
const DESK_FONTS = ['noto-serif-sc-400.woff2', 'source-serif-4-400.woff2', 'source-serif-4-500.woff2']
const MB = 1024 * 1024
const sizeOf = (dir: URL, names: string[]) => names.reduce((n, f) => n + statSync(new URL(f, dir)).size, 0)

describe('bundled fonts (spec §3)', () => {
  const app = new URL('../apps/app/assets/fonts/', import.meta.url)
  const desk = new URL('../apps/desktop/src/fonts/', import.meta.url)
  it('both apps ship the serif families with their OFL licence', () => {
    for (const f of [...APP_FONTS, 'OFL.txt']) expect(existsSync(new URL(f, app)), f).toBe(true)
    for (const f of [...DESK_FONTS, 'OFL.txt']) expect(existsSync(new URL(f, desk)), f).toBe(true)
    for (const d of [app, desk]) {
      const ofl = readFileSync(new URL('OFL.txt', d), 'utf8')
      expect(ofl).toMatch(/SIL OPEN FONT LICENSE/i)
      for (const who of ['Noto', 'Source Serif 4', 'Geist']) expect(ofl, who).toContain(who)
    }
  })
  it('no CJK Medium is built (ruling D1)', () => {
    expect(existsSync(new URL('NotoSerifSC-Medium.ttf', app))).toBe(false)
    expect(existsSync(new URL('noto-serif-sc-500.woff2', desk))).toBe(false)
  })
  it('stays within the 15 MB budget per app', () => {
    expect(sizeOf(app, APP_FONTS)).toBeLessThanOrEqual(15 * MB)
    expect(sizeOf(desk, DESK_FONTS)).toBeLessThanOrEqual(15 * MB)
  })
  it('the sans Geist is retired; only Geist Mono stays for code', () => {
    expect(readdirSync(desk).filter(f => /^geist-variable/.test(f))).toEqual([])
    expect(existsSync(new URL('geist-mono-variable-latin.woff2', desk))).toBe(true)
  })
  it('sources.lock.json holds real sha256 values and pinned commits', () => {
    const lock = JSON.parse(readFileSync(new URL('./fonts/sources.lock.json', import.meta.url), 'utf8'))
    const hex = /^[0-9a-f]{64}$/
    for (const v of [lock.notoSerifSC.sha256, lock.notoSerifSC.oflSha256, lock.sourceSerif4.sha256, lock.sourceSerif4.oflSha256, lock.geistMonoLicense.sha256]) expect(v).toMatch(hex)
    for (const v of [lock.notoSerifSC.commit, lock.sourceSerif4.commit]) expect(v).toMatch(/^[0-9a-f]{40}$/)
  })
  it('Source Serif subsets do not carry the Reserved Font Name "Source" in their family names', () => {
    for (const f of ['SourceSerif4-Regular.ttf', 'SourceSerif4-Medium.ttf']) {
      const b = readFileSync(new URL(f, app))
      // name table strings are UTF-16BE or latin1; the old family string must be gone from both encodings
      expect(b.includes(Buffer.from('Source Serif', 'latin1')), f).toBe(false)
      expect(b.includes(Buffer.from('Source Serif', 'utf16le').swap16()), f).toBe(false)
    }
  })
})
