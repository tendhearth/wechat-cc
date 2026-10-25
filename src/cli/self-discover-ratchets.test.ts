// @repo-guard 这份测试里有扫整个仓库的守卫:bun run verify 不管改了什么都跑它(import 图看不见它守的文件)。
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { formatRatchetDebts, ratchetDebts } from './self-discover-ratchets'

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts')

describe('ratchetDebts', () => {
  it('只认 @debt 标记下一行的常量:单个数字、按文件的表(嵌套也求和、注释行跳过);没标的不收', () => {
    const text = [
      '// @debt 链接次数',
      'const MAX = 38',
      '// @debt 按文件的',
      'const BASELINE: Record<string, Partial<Record<K, number>>> = {',
      "  'a.ts': { Ref: 2, 'lc.register': 14 },",
      '  // 过渡桥: 99',
      "  'b.ts': 3,",
      '}',
      'const NOT_DEBT = 70',
    ].join('\r\n')
    expect(ratchetDebts([{ path: 'scripts/x.guard.test.ts', text }])).toEqual([
      { guard: 'scripts/x.guard.test.ts', what: '链接次数', total: 38, files: null },
      { guard: 'scripts/x.guard.test.ts', what: '按文件的', total: 19, files: 2 },
    ])
  })

  it('真守卫上的两个标记都还认得出(守卫改了写法,这里先红,别让这一源安静地变空)', () => {
    const files = readdirSync(SCRIPTS).filter(f => f.endsWith('.guard.test.ts')).map(f => ({ path: `scripts/${f}`, text: readFileSync(join(SCRIPTS, f), 'utf8') }))
    const guards = ratchetDebts(files).map(d => d.guard).sort()
    expect(guards).toEqual(['scripts/cli-ratchet.guard.test.ts', 'scripts/daemon-module.guard.test.ts'])
    for (const d of ratchetDebts(files)) expect(d.total, d.guard).toBeGreaterThanOrEqual(0)
  })

  it('人读版:清零的不列;全清零就说清零', () => {
    expect(formatRatchetDebts([{ guard: 'g', what: 'w', total: 0, files: 0 }])).toContain('都已清零')
    expect(formatRatchetDebts([{ guard: 'g', what: '链接次数', total: 38, files: null }])).toMatch(/38 {2}链接次数 {2}— g/)
  })
})
