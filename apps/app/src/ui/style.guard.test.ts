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
/** 还没换到 Txt / TextField 的文件(Task 3 时的真实快照:25 个)。Task 5 / 6 / 7 逐个删,Task 7 结束时必须为空;只许删不许加。 */
export const NOT_YET_MIGRATED = new Set<string>([
  'app/(tabs)/index.tsx', 'app/(tabs)/together.tsx', 'app/approval/[id].tsx', 'app/chat.tsx', 'app/compose.tsx',
  'app/connections.tsx', 'app/dev-push-key.tsx', 'app/devices.tsx', 'app/matter/[id].tsx', 'app/pair.tsx',
  'app/push-open.tsx', 'app/sessions/[key].tsx', 'app/sessions/index.tsx', 'app/settings.tsx', 'app/welcome.tsx',
  'ui/Button.tsx', 'ui/ConnectionNotice.tsx', 'ui/DemoBanner.tsx', 'ui/Placeholder.tsx', 'ui/PushBanner.tsx',
  'ui/SayBar.tsx', 'ui/Sheet.tsx', 'ui/StatusPill.tsx', 'ui/TabBar.tsx', 'ui/TopBar.tsx',
])

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
  })
})
