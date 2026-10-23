/**
 * 主人原话 owner.md 只有一个写者(记忆编辑设计稿 docs/superpowers/specs/2026-10-23-memory-edits-stick-design.md §1):
 * lib/memory-owner 的 writeOwnerAssertions。CC 的 MCP、桌面整份覆盖、nightly、gardener、合成都不能写它 —— 不然「主人亲口说的」
 * 就可能被机器改掉,这正是这份稿要在结构上排除的。
 *
 * 守法:文件名只许出现在下面这张表里的文件(按「谁提到它」数,不猜写法)。新加一处要提到 owner.md,先想清楚它是不是写者:
 * 是写者 ⇒ 改成调 writeOwnerAssertions;只读 ⇒ 用 readOwnerDoc,不用直接拼文件名。
 * 只扫生产代码(排除 *.test.ts);注释行按行跳(块注释正则会吞代码)。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
/** 允许提到 owner.md / OWNER_FILENAME 的文件,和为什么。 */
const ALLOWED: Record<string, string> = {
  'src/lib/memory-owner.ts': '唯一的写者 + 读者',
  'src/lib/memory-artifacts.ts': '清单里登记它是源',
  'src/daemon/memory/fs-api.ts': '拒写:CC 的 MCP memory_write / delete 走这里',
  'src/lib/memory.ts': '拒写:CLI / 桌面 memory write 整份覆盖走这里',
}

const MENTION = /owner\.md|OWNER_FILENAME/i

export function mentionsOwnerFile(src: string): boolean {
  return src.split('\n').some(line => !/^\s*(\/\/|\/\*|\*)/.test(line) && MENTION.test(line))
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
  it('只有登记过的文件提到 owner.md', () => {
    const offenders = [...walk(join(ROOT, 'src')), join(ROOT, 'cli.ts')]
      .map(f => relative(ROOT, f).split('\\').join('/'))
      .filter(rel => !(rel in ALLOWED) && mentionsOwnerFile(readFileSync(join(ROOT, rel), 'utf8')))
    expect(offenders, '提到 owner.md 的新文件:写就调 writeOwnerAssertions、读就调 readOwnerDoc,别直接拼文件名').toEqual([])
  })

  it('登记过的文件真的还提到它(删掉了就把这一行也删掉)', () => {
    const stale = Object.keys(ALLOWED).filter(rel => !mentionsOwnerFile(readFileSync(join(ROOT, rel), 'utf8')))
    expect(stale).toEqual([])
  })

  it('识别得出', () => {
    expect(mentionsOwnerFile(`writeFileSync(join(root, 'owner.md'), x)`)).toBe(true)
    expect(mentionsOwnerFile(`// owner.md 只读`)).toBe(false)
    expect(mentionsOwnerFile(`import { OWNER_FILENAME } from './memory-owner'`)).toBe(true)
  })
})
