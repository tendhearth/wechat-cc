/**
 * 主人原话 owner.md 只有一个写者(记忆编辑设计稿 docs/superpowers/specs/2026-10-23-memory-edits-stick-design.md §1):
 * lib/memory-owner 的 writeOwnerAssertions。CC 的 MCP、桌面整份覆盖、nightly、gardener、合成都不能写它 —— 不然「主人亲口说的」
 * 就可能被机器改掉,这正是这份稿要在结构上排除的。
 *
 * 守法:**拼出 owner.md 的路径**(`join(…, OWNER_FILENAME)` / `join(…, 'owner.md')` / `…/owner.md'`)只许在下面这张表里的文件。
 * 要写它就得先有路径,所以拼路径的地方就是可能的写者;只提到名字的(编辑接口的 path 枚举、CLI 帮助、拒写时的比较)不算。
 * 新代码要碰它:写 ⇒ 调 writeOwnerAssertions;读 ⇒ 调 readOwnerDoc。
 * 只扫生产代码(排除 *.test.ts);注释行按行跳(块注释正则会吞代码)。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
/** 允许拼出 owner.md 路径的文件,和为什么。 */
const ALLOWED: Record<string, string> = {
  'src/lib/memory-owner.ts': '唯一的写者(writeOwnerAssertions)+ 读者(readOwnerDoc)',
}

const OWNER_PATH = /join\([^)\n]*(?:OWNER_FILENAME|['"`]owner\.md)|[\\/]owner\.md['"`]/i

export function mentionsOwnerFile(src: string): boolean {
  return src.split('\n').some(line => !/^\s*(\/\/|\/\*|\*)/.test(line) && OWNER_PATH.test(line))
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(p)
  }
  return out
}

describe('owner.md 只有一个写者', () => {
  it('只有登记过的文件拼得出 owner.md 的路径', () => {
    const offenders = [...walk(join(ROOT, 'src')), join(ROOT, 'cli.ts')]
      .map(f => relative(ROOT, f).split('\\').join('/'))
      .filter(rel => !(rel in ALLOWED) && mentionsOwnerFile(readFileSync(join(ROOT, rel), 'utf8')))
    expect(offenders, '拼 owner.md 路径的新文件:写就调 writeOwnerAssertions、读就调 readOwnerDoc,别直接拼路径').toEqual([])
  })

  it('登记过的文件真的还提到它(删掉了就把这一行也删掉)', () => {
    const stale = Object.keys(ALLOWED).filter(rel => !mentionsOwnerFile(readFileSync(join(ROOT, rel), 'utf8')))
    expect(stale).toEqual([])
  })

  it('识别得出', () => {
    expect(mentionsOwnerFile(`writeFileSync(join(root, 'owner.md'), x)`)).toBe(true)
    expect(mentionsOwnerFile(`const p = join(root, OWNER_FILENAME)`)).toBe(true)
    expect(mentionsOwnerFile("appendFileSync(`${root}/owner.md`, x)")).toBe(true)
    expect(mentionsOwnerFile(`// join(root, 'owner.md')`)).toBe(false)
    expect(mentionsOwnerFile(`z.enum(['_overview.md', 'memory.md', 'owner.md'])`)).toBe(false)
    expect(mentionsOwnerFile(`if (rel.toLowerCase() === OWNER_FILENAME) throw`)).toBe(false)
  })
})
