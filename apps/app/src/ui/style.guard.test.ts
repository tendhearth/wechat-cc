// 手机样式守卫(spec 2026-10-01 §5):没有深色、不设字重、不写字面色值、文字都走 Txt / TextField。
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC = join(__dirname, '..')
const walk = (d: string, out: string[] = []): string[] => {
  for (const n of readdirSync(d)) { const f = join(d, n); statSync(f).isDirectory() ? walk(f, out) : out.push(f) }
  return out
}
const TSX = walk(SRC).filter(f => f.endsWith('.tsx'))
const rel = (f: string) => relative(SRC, f).split('\\').join('/')
/** 还没换到 Txt / TextField 的文件。Task 7 起为空:所有页面都已迁移,不许再加。 */
export const NOT_YET_MIGRATED = new Set<string>([])
/** 棘轮上限:0。 */
const NOT_YET_MIGRATED_CAP = 0
const CONTAINERS = /<\/?(Card|Sheet)\b/g

describe('phone style guard', () => {
  it('no dark mode anywhere', () => {
    for (const f of walk(SRC).filter(f => /\.tsx?$/.test(f) && !f.endsWith('.test.ts'))) expect(readFileSync(f, 'utf8'), rel(f)).not.toMatch(/useColorScheme|DarkTheme/)
  })
  it('never sets fontWeight (weights come from the family name)', () => {
    for (const f of TSX) expect(readFileSync(f, 'utf8'), rel(f)).not.toMatch(/fontWeight/)
  })
  it('no literal colours in components', () => {
    for (const f of TSX) expect(readFileSync(f, 'utf8').match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g) ?? [], rel(f)).toEqual([])
  })
  it('text goes through Txt / TextField (ratchet: NOT_YET_MIGRATED only shrinks)', () => {
    const offenders = TSX.filter(f => !['ui/Txt.tsx', 'ui/TextField.tsx'].includes(rel(f)))
      .filter(f => /import\s*\{[^}]*\b(Text|TextInput)\b[^}]*\}\s*from\s*'react-native'/.test(readFileSync(f, 'utf8')))
      .map(rel)
    expect(offenders.filter(f => !NOT_YET_MIGRATED.has(f))).toEqual([])
    expect([...NOT_YET_MIGRATED].filter(f => !offenders.includes(f)), '已迁移的页面请从 NOT_YET_MIGRATED 删掉').toEqual([])
    expect(NOT_YET_MIGRATED.size, 'NOT_YET_MIGRATED 只许变小').toBeLessThanOrEqual(NOT_YET_MIGRATED_CAP)
  })
  it('every screen is migrated', () => { expect([...NOT_YET_MIGRATED]).toEqual([]) })
  // 发图 2026-10-06 已上线(跟 CC 说 / 新交办),不再拦;麦克风还没有。
  it('no buttons for unshipped features (mic)', () => {
    for (const f of TSX) expect(readFileSync(f, 'utf8'), rel(f)).not.toMatch(/testID="[^"]*mic[^"]*"/)
  })
  it('selected state is restrained (no rail colour block behind a chosen row / tab)', () => {
    for (const f of TSX) expect(readFileSync(f, 'utf8').match(/on \? c\.rail|focused \? c\.rail|selected \? c\.rail/g) ?? [], rel(f)).toEqual([])
  })
  it('detail-page titles use the title size, not display (display only for the Now greeting and the welcome hero)', () => {
    for (const f of TSX.filter(f => !['app/(tabs)/index.tsx', 'app/welcome.tsx'].includes(rel(f)))) expect(readFileSync(f, 'utf8'), rel(f)).not.toMatch(/role="display"/)
  })
  it('top-bar status line only on the two tab pages (detail pages: back button, no status; ConnectionNotice covers problems)', () => {
    expect(readFileSync(join(SRC, 'ui/TopBar.tsx'), 'utf8')).toMatch(/showStatus = false/)
    const TABS = ['app/(tabs)/index.tsx', 'app/(tabs)/together.tsx']
    for (const f of TSX.filter(f => rel(f) !== 'ui/TopBar.tsx')) {
      for (const bar of readFileSync(f, 'utf8').match(/<TopBar\b[\s\S]*?\/>/g) ?? []) {
        if (TABS.includes(rel(f))) expect(bar, rel(f)).toMatch(/\bshowStatus\b/)
        else expect(bar, rel(f)).not.toMatch(/\bshowStatus\b|onConnection/)
        if (/\bshowStatus\b/.test(bar)) expect(bar, rel(f)).not.toMatch(/\bonBack=/)
      }
    }
  })
  it('no legacy palette keys (bg/card/muted/line/primary/primaryInk/navOnBg/navOnInk/accentSoft/danger)', () => {
    for (const f of TSX) expect(readFileSync(f, 'utf8').match(/\bc\.(bg|card|muted|line|primary|primaryInk|navOnBg|navOnInk|accentSoft|danger)\b/g) ?? [], rel(f)).toEqual([])
    expect(readFileSync(join(SRC, 'ui/useTheme.ts'), 'utf8')).not.toMatch(/LegacyAliases|accentSoft|navOnBg/)
  })
  it('no old radius aliases (card/button/pill → sheet/control/nav)', () => {
    for (const f of walk(SRC).filter(f => /\.tsx?$/.test(f) && !f.endsWith('.test.ts'))) expect(readFileSync(f, 'utf8').match(/\bradius\.(card|button|pill)\b/g) ?? [], rel(f)).toEqual([])
    expect(readFileSync(join(SRC, 'ui/tokens.ts'), 'utf8')).not.toMatch(/\b(card|button|pill):/)
  })
  it('status colours only on Dot (no ok/warn text colour)', () => {
    for (const f of TSX.filter(f => !f.endsWith('Dot.tsx'))) expect(readFileSync(f, 'utf8').match(/color:\s*c\.(ok|warn)\b|tone="(ok|warn)"|\bc\.(ok|warn)\b/g) ?? [], rel(f)).toEqual([])
  })
  it('no nested cards (a Card / Sheet never sits inside another Card / Sheet)', () => {
    for (const f of TSX) {
      let depth = 0, max = 0
      for (const m of readFileSync(f, 'utf8').matchAll(CONTAINERS)) { depth += m[0].startsWith('</') ? -1 : 1; max = Math.max(max, depth) }
      expect(max, rel(f)).toBeLessThanOrEqual(1)
    }
  })
})
