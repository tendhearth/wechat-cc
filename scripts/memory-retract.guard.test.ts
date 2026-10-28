/**
 * 一种收回(架构终态 G5,设计稿 docs/superpowers/specs/2026-10-25-memory-single-source-design.md §2.3 / §3)。
 *
 * 1. 主人事实表的状态只经店面 src/adapters/store/memory-facts.ts 改(retract / restore / resolve / supersede,以及导入 / 落库的
 *    mirror 共用的那一个 setStatus):别处写 `UPDATE memory_facts SET … status` ⇒ 红。基线 0。
 * 2. `'corrections.md'` 这个文件名只在导入(fact-import.ts:读旧文件)、导出器(memory-export.ts:主人 10-26 第 2 条,只读导出再留
 *    一个版本)和记忆目录的分类表(lib/memory-artifacts.ts)里出现。名单从表里来,没人再解析它。基线 0(除这三处)。
 * 只扫生产代码(排除 *.test.ts);注释行按行跳。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const STATUS_UPDATE = /UPDATE\s+memory_facts\s+SET\b[^;]*\bstatus\b/i
const CORRECTIONS_LITERAL = /['"`]corrections\.md['"`]/
const STORE = 'src/adapters/store/memory-facts.ts'
const CORRECTIONS_ALLOWED: Record<string, string> = {
  'src/features/memory/fact-import.ts': '导入:读旧的 corrections.md',
  'src/features/memory/memory-export.ts': '只读导出(主人 10-26 第 2 条:再留一个版本);没搬进表的对话照旧追加',
  'src/lib/memory-artifacts.ts': '记忆目录里每样东西的分类表',
}

const codeLines = (src: string) => src.split('\n').filter(l => !/^\s*(\/\/|\/\*|\*)/.test(l))
export const updatesFactStatus = (src: string) => codeLines(src).some(l => STATUS_UPDATE.test(l))
export const namesCorrectionsFile = (src: string) => codeLines(src).some(l => CORRECTIONS_LITERAL.test(l))

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(p)
  }
  return out
}
const files = () => [...walk(join(ROOT, 'src')), join(ROOT, 'cli.ts')].map(f => relative(ROOT, f).split('\\').join('/'))

describe('一种收回(G5)', () => {
  it('memory_facts 的状态只在店面里改', () => {
    const offenders = files().filter(rel => rel !== STORE && updatesFactStatus(readFileSync(join(ROOT, rel), 'utf8')))
    expect(offenders, '改主人事实的状态:调 MemoryFactsStore 的 retract / restore / resolve / supersede(或 mirror)').toEqual([])
    expect(updatesFactStatus(readFileSync(join(ROOT, STORE), 'utf8'))).toBe(true)
  })

  it("'corrections.md' 只在导入、导出器和分类表里", () => {
    const offenders = files().filter(rel => !(rel in CORRECTIONS_ALLOWED) && namesCorrectionsFile(readFileSync(join(ROOT, rel), 'utf8')))
    expect(offenders, '收回的话从表里读:MemoryWriter 的 retractions / retractedTexts / correctionsText').toEqual([])
    const stale = Object.keys(CORRECTIONS_ALLOWED).filter(rel => !namesCorrectionsFile(readFileSync(join(ROOT, rel), 'utf8')))
    expect(stale, '登记过的文件不再提到它了:把那一行删掉').toEqual([])
  })

  it('识别得出', () => {
    expect(updatesFactStatus("db.query('UPDATE memory_facts SET status = ? WHERE id = ?')")).toBe(true)
    expect(updatesFactStatus('db.query(`UPDATE memory_facts SET text = ?, status = ? WHERE id = ?`)')).toBe(true)
    expect(updatesFactStatus("db.query('UPDATE memory_facts SET ord = ? WHERE id = ?')")).toBe(false)
    expect(updatesFactStatus("// UPDATE memory_facts SET status = 'x'")).toBe(false)
    expect(namesCorrectionsFile("join(root, 'corrections.md')")).toBe(true)
    expect(namesCorrectionsFile("const hint = 'corrections.md 由后台维护'")).toBe(false)
  })
})
