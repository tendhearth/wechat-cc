/**
 * daemon 里读 memory.md / owner.md 只经导出器(架构终态 G6,设计稿 docs/superpowers/specs/2026-10-25-memory-single-source-design.md §3)。
 *
 * G4 起这两份文件只是从主库的表导出来的;G6 起读者也读表(src/features/memory/memory-export.ts 的 memoryMd / memoryDoc / ownerDoc /
 * ownerMd,没搬进表的对话由它照旧读文件)。守法:生产代码里一行同时有「读文件」的调用(readFileSync / readIf / readText / `.read(` /
 * existsSync / copyFileSync)和这两份文件(常量名、字面量、整理里惯用的 memPath),或者调 readOwnerDoc(读 owner.md 文件的那个函数),
 * 只许在导出器、导入(读旧文件)、readOwnerDoc 自己的定义处,和 CLI 的离线命令(src/cli/**,daemon 不在时读磁盘)里。基线 0。
 *
 * 看不见的:按目录逐个读所有 .md 的(快照、回忆、合成的生活侧素材)用的是变量文件名 —— 它们在 G6 里逐个改成了遇到这两份就问导出器,
 * 测试在各自的 *.test.ts。_overview.md 的读者到 G8(总览缓存进表)才换,照旧由 scripts/memory-overview-readers.guard.test.ts 管。
 * 只扫生产代码(排除 *.test.ts);注释行按行跳。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const READ_CALL = /\b(?:readFileSync|readIf|readText|existsSync|copyFileSync)\(|\.read\(/
const FILE = /\b(?:MEMORY_FILENAME|OWNER_FILENAME|memPath)\b|['"`/](?:memory|owner)\.md['"`]/
const OWNER_READER = /\breadOwnerDoc\(/
const ALLOWED: Record<string, string> = {
  'src/features/memory/memory-export.ts': '唯一的读者(从表渲染;没搬进表的对话读文件)',
  'src/lib/memory-owner.ts': 'readOwnerDoc 的定义(CLI 离线命令用)',
}

const codeLines = (src: string) => src.split('\n').filter(l => !/^\s*(\/\/|\/\*|\*)/.test(l))
export const readsMemoryFile = (src: string) => codeLines(src).some(l => (READ_CALL.test(l) && FILE.test(l)) || OWNER_READER.test(l))

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(p)
  }
  return out
}

describe('daemon 里读 memory.md / owner.md 只经导出器(G6,基线 0)', () => {
  it('没有别的生产文件直接读这两份', () => {
    const offenders = walk(join(ROOT, 'src')).map(f => relative(ROOT, f).split('\\').join('/'))
      .filter(rel => !(rel in ALLOWED) && !rel.startsWith('src/cli/') && readsMemoryFile(readFileSync(join(ROOT, rel), 'utf8')))
    expect(offenders, '读主人的记忆改调 MemoryWriter(memoryFactsFor):memoryMd / memoryDoc / ownerDoc / ownerMd').toEqual([])
  })
  it('登记过的文件真的在读(删了就把那一行也删掉)', () => {
    expect(Object.keys(ALLOWED).filter(rel => !readsMemoryFile(readFileSync(join(ROOT, rel), 'utf8')))).toEqual([])
  })
  it('识别得出', () => {
    expect(readsMemoryFile("const raw = readFileSync(join(r, MEMORY_FILENAME), 'utf8')")).toBe(true)
    expect(readsMemoryFile("memoryOf(c).read(MEMORY_FILENAME)")).toBe(true)
    expect(readsMemoryFile("fs.read(`${chatId}/memory.md`)")).toBe(true)
    expect(readsMemoryFile("const firstRun = !existsSync(memPath)")).toBe(true)
    expect(readsMemoryFile("const doc = readOwnerDoc(root)")).toBe(true)
    expect(readsMemoryFile("// readFileSync(join(r, 'memory.md'))")).toBe(false)
    expect(readsMemoryFile("const doc = deps.writer.memoryDoc(owner)")).toBe(false)
    expect(readsMemoryFile("readFileSync(join(r, 'profile.md'), 'utf8')")).toBe(false)
  })
})
