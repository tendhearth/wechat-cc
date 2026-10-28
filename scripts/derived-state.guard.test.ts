/**
 * 生成物的过期围栏在主库(架构终态 G8,设计稿 docs/superpowers/specs/2026-10-25-memory-single-source-design.md §3):
 * `lib/memory-derived-state.ts` 删掉了,`'.derived-state.json'` 这个文件名只许出现在开机导入(把旧文件读进表)里。基线 0。
 * 只扫生产代码(排除 *.test.ts);注释行按行跳。
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const IMPORTER = 'src/features/memory/fact-import.ts'
const LITERAL = /['"`]\.derived-state\.json['"`]/
export const namesDerivedState = (src: string) => src.split('\n').some(l => !/^\s*(\/\/|\/\*|\*)/.test(l) && LITERAL.test(l))

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(p)
  }
  return out
}

describe("'.derived-state.json' 只在导入里(G8,基线 0)", () => {
  it('没有别的生产文件提到它,旧模块已经删掉', () => {
    const offenders = [...walk(join(ROOT, 'src')), join(ROOT, 'cli.ts')].map(f => relative(ROOT, f).split('\\').join('/'))
      .filter(rel => rel !== IMPORTER && namesDerivedState(readFileSync(join(ROOT, rel), 'utf8')))
    expect(offenders, '生成物的过期看主库:makeMemoryFactsStore(db).fence(chatId)').toEqual([])
    expect(namesDerivedState(readFileSync(join(ROOT, IMPORTER), 'utf8'))).toBe(true)
    expect(existsSync(join(ROOT, 'src', 'lib', 'memory-derived-state.ts'))).toBe(false)
  })
  it('识别得出', () => {
    expect(namesDerivedState("join(root, '.derived-state.json')")).toBe(true)
    expect(namesDerivedState("// '.derived-state.json'")).toBe(false)
  })
})
