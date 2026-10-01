// 桌面 tokens.css 是生成物:与 packages/design-tokens 渲染结果逐字一致;手机色板就是同一个对象。
import { describe, it, expect } from 'vitest'
import { readFileSync, statSync, existsSync, readdirSync } from 'node:fs'
import { color, fontFamily, renderTokensCss } from '../packages/design-tokens/src/index'
import { palette } from '../apps/app/src/ui/tokens'

describe('one set of design tokens across desktop and phone', () => {
  it('apps/desktop/src/tokens.css is up to date (run: bun scripts/build-design-tokens.ts)', () => {
    expect(readFileSync(new URL('../apps/desktop/src/tokens.css', import.meta.url), 'utf8')).toBe(renderTokensCss())
  })
  it('phone palette is the shared palette (no mirror to drift)', () => {
    expect(palette).toBe(color)
  })
})

// ---- bundled fonts (spec §3;裁决 D1:Noto Serif SC 只有 Regular;预算每端 15 MB) ----
const APP_FONTS = ['NotoSerifSC-Regular.ttf', 'THSerif4-Regular.ttf', 'THSerif4-Medium.ttf']
const DESK_FONTS = ['noto-serif-sc-400.woff2', 'th-serif-4-400.woff2', 'th-serif-4-500.woff2']
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
    for (const v of [lock.notoSerifSC.commit, lock.sourceSerif4.commit, lock.geistMonoLicense.commit]) expect(v).toMatch(/^[0-9a-f]{40}$/)
    for (const k of ['notoSerifSC', 'sourceSerif4', 'geistMonoLicense']) expect(lock[k].url, k).toContain(`/${lock[k].commit}/`)
  })
  it('Source Serif subsets do not carry the Reserved Font Name "Source" in their family names', () => {
    for (const f of ['THSerif4-Regular.ttf', 'THSerif4-Medium.ttf']) {
      const b = readFileSync(new URL(f, app))
      // name table strings are UTF-16BE or latin1; the old family string must be gone from both encodings
      expect(b.includes(Buffer.from('Source Serif', 'latin1')), f).toBe(false)
      expect(b.includes(Buffer.from('Source Serif', 'utf16le').swap16()), f).toBe(false)
    }
  })
  // Reserved Font Name 'Source':被改过的子集不能以 "Source Serif" 之名呈现给用户 —— 桌面 CSS/token 与文件名同样不行。
  it('desktop never presents the subset under the Reserved Font Name (CSS, tokens, file names)', () => {
    expect(fontFamily.serifLatin).not.toMatch(/Source Serif/i)
    const cssDir = new URL('../apps/desktop/src/', import.meta.url)
    const cssFiles: string[] = []
    const walk = (dir: URL) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(new URL(e.name + '/', dir)); continue }
        if (/\.(css|html|js|ts)$/.test(e.name)) cssFiles.push(new URL(e.name, dir).pathname)
      }
    }
    walk(cssDir)
    expect(cssFiles.length).toBeGreaterThan(0)
    for (const f of cssFiles) {
      const src = readFileSync(f, 'utf8')
      expect(/font-family\s*:[^;}]*Source Serif/i.test(src), f).toBe(false)
      expect(/--th-font-[a-z-]+\s*:[^;}]*Source Serif/i.test(src), f).toBe(false)
    }
    const serifWoff2 = readdirSync(desk).filter(f => /serif/i.test(f) && !/noto/i.test(f) && f.endsWith('.woff2'))
    expect(serifWoff2.sort()).toEqual(['th-serif-4-400.woff2', 'th-serif-4-500.woff2'])
    expect(readdirSync(desk).filter(f => /source/i.test(f))).toEqual([])
    expect(readdirSync(app).filter(f => /source/i.test(f))).toEqual([])
  })
})
