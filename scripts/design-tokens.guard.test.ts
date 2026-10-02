// 桌面 tokens.css 是生成物:与 packages/design-tokens 渲染结果逐字一致;手机色板就是同一个对象。
import { describe, it, expect } from 'vitest'
import { readFileSync, statSync, existsSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
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

// ---- bundled fonts (spec §3;裁决 D1:Noto Serif SC 只有 Regular;§9-5 CJK 只留常用字) ----
const APP_FONTS = ['NotoSerifSC-Regular.ttf', 'THSerif4-Regular.ttf', 'THSerif4-Medium.ttf']
const DESK_FONTS = ['noto-serif-sc-400.woff2', 'th-serif-4-400.woff2', 'th-serif-4-500.woff2']
const MB = 1024 * 1024
const sizeOf = (dir: URL, names: string[]) => names.reduce((n, f) => n + statSync(new URL(f, dir)).size, 0)

/** TrueType cmap(format 4 / 12)里有哪些码位 —— 只为守卫测试,够用即可。 */
function cmapOf(buf: Buffer): Set<number> {
  const numTables = buf.readUInt16BE(4)
  let cmap = -1
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16
    if (buf.toString('latin1', rec, rec + 4) === 'cmap') cmap = buf.readUInt32BE(rec + 8)
  }
  if (cmap < 0) throw new Error('no cmap table')
  const out = new Set<number>()
  const n = buf.readUInt16BE(cmap + 2)
  for (let i = 0; i < n; i++) {
    const sub = cmap + buf.readUInt32BE(cmap + 4 + i * 8 + 4)
    const format = buf.readUInt16BE(sub)
    if (format === 12) {
      const groups = buf.readUInt32BE(sub + 12)
      for (let g = 0; g < groups; g++) {
        const at = sub + 16 + g * 12
        for (let c = buf.readUInt32BE(at); c <= buf.readUInt32BE(at + 4); c++) out.add(c)
      }
    } else if (format === 4) {
      const segX2 = buf.readUInt16BE(sub + 6), ends = sub + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2
      for (let k = 0; k < segX2 / 2; k++) {
        const end = buf.readUInt16BE(ends + k * 2), start = buf.readUInt16BE(starts + k * 2)
        const delta = buf.readInt16BE(deltas + k * 2), rOff = buf.readUInt16BE(ranges + k * 2)
        for (let c = start; c <= end && c !== 0xffff; c++) {
          const glyph = rOff === 0 ? (c + delta) & 0xffff : buf.readUInt16BE(ranges + k * 2 + rOff + (c - start) * 2)
          if (glyph !== 0) out.add(c)
        }
      }
    }
  }
  return out
}

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
  // 2026-10-01 主人拍板(spec §9-5)CJK 只留常用字后:手机 10.8 → 3.8 MB、桌面 4.3 → 1.6 MB。预算跟着收紧,只许减不许增。
  it('stays within the post-subset budget (phone 4.5 MB, desktop 2 MB)', () => {
    expect(sizeOf(app, APP_FONTS)).toBeLessThanOrEqual(4.5 * MB)
    expect(sizeOf(desk, DESK_FONTS)).toBeLessThanOrEqual(2 * MB)
  })
  it('the 通用规范汉字表 list is the pinned one (6500 chars, sha256 in sources.lock.json)', () => {
    const lock = JSON.parse(readFileSync(new URL('./fonts/sources.lock.json', import.meta.url), 'utf8'))
    const raw = readFileSync(new URL('./fonts/tgscc-level-1-2.txt', import.meta.url))
    expect(createHash('sha256').update(raw).digest('hex')).toBe(lock.tgscc.sha256)
    const chars = raw.toString('utf8').split('\n').filter(Boolean)
    expect(chars.length).toBe(6500)
    expect(new Set(chars).size).toBe(6500)
  })
  it('the CJK subset covers every 通用规范 一级 + 二级 char and common punctuation, and drops rare / traditional ones', () => {
    const cmap = cmapOf(readFileSync(new URL('NotoSerifSC-Regular.ttf', app)))
    const missing = readFileSync(new URL('./fonts/tgscc-level-1-2.txt', import.meta.url), 'utf8').split('\n').filter(Boolean).filter(c => !cmap.has(c.codePointAt(0)!))
    expect(missing).toEqual([])
    for (const c of '的一是了我,。!?「」《》、…—ＡＢ１２abc') expect(cmap.has(c.codePointAt(0)!), c).toBe(true)
    // 通用规范里有、GB2312 里没有的(啰),和 GB2312 里有、通用规范一二级里没有的(丌 亻 傺)—— 两份并集都在
    for (const c of '啰丌亻傺') expect(cmap.has(c.codePointAt(0)!), c).toBe(true)
    // 子集外 ⇒ 交给系统衬线逐字兜底
    for (const c of '龘鬱䶮') expect(cmap.has(c.codePointAt(0)!), c).toBe(false)
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
    const cssFiles: URL[] = []
    const walk = (dir: URL) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(new URL(e.name + '/', dir)); continue }
        if (/\.(css|html|js|ts)$/.test(e.name)) cssFiles.push(new URL(e.name, dir))
      }
    }
    walk(cssDir)
    expect(cssFiles.length).toBeGreaterThan(0)
    for (const f of cssFiles) {
      const src = readFileSync(f, 'utf8')
      expect(/font-family\s*:[^;}]*Source Serif/i.test(src), f.href).toBe(false)
      expect(/--th-font-[a-z-]+\s*:[^;}]*Source Serif/i.test(src), f.href).toBe(false)
    }
    const serifWoff2 = readdirSync(desk).filter(f => /serif/i.test(f) && !/noto/i.test(f) && f.endsWith('.woff2'))
    expect(serifWoff2.sort()).toEqual(['th-serif-4-400.woff2', 'th-serif-4-500.woff2'])
    expect(readdirSync(desk).filter(f => /source/i.test(f))).toEqual([])
    expect(readdirSync(app).filter(f => /source/i.test(f))).toEqual([])
  })
})
