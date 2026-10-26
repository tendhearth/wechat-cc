/**
 * 联系人事实进主库以后,`'facts.db'` 这个文件名只许出现在开机导入里(架构终态 G7,设计稿
 * docs/superpowers/specs/2026-10-25-memory-single-source-design.md §3)。知识库的店面不再打开它,备份也不再拷它;
 * 旧文件只读、不删、不改名(主人 10-26 第 5 条)。基线 0。只扫生产代码(排除 *.test.ts);注释行按行跳。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const IMPORTER = 'src/adapters/knowledge/facts-import.ts'
const LITERAL = /['"`]facts\.db['"`]/
export const namesFactsDb = (src: string) => src.split('\n').some(l => !/^\s*(\/\/|\/\*|\*)/.test(l) && LITERAL.test(l))

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(p)
  }
  return out
}

describe("'facts.db' 只在导入里(G7,基线 0)", () => {
  it('没有别的生产文件提到它', () => {
    const offenders = [...walk(join(ROOT, 'src')), join(ROOT, 'cli.ts')].map(f => relative(ROOT, f).split('\\').join('/'))
      .filter(rel => rel !== IMPORTER && namesFactsDb(readFileSync(join(ROOT, rel), 'utf8')))
    expect(offenders, '联系人事实在主库(makeMemoryFactsStore(db).contactFacts);facts.db 只由开机导入读').toEqual([])
    expect(namesFactsDb(readFileSync(join(ROOT, IMPORTER), 'utf8'))).toBe(true)
  })
  it('识别得出', () => {
    expect(namesFactsDb("openSqlite(join(root, 'facts.db'))")).toBe(true)
    expect(namesFactsDb("join('knowledge', \"facts.db\")")).toBe(true)
    expect(namesFactsDb("// join(root, 'facts.db')")).toBe(false)
  })
})
