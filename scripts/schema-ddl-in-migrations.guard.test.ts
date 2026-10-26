/**
 * 建表 / 改表只许写在迁移里(架构终态 G1,设计稿 docs/superpowers/specs/2026-10-25-memory-single-source-design.md §3)。
 *
 * 以前知识库四个库的表结构写在 src/adapters/knowledge/store.ts 里:`CREATE TABLE IF NOT EXISTS` + 按 `PRAGMA table_info`
 * 守着的 `ALTER TABLE`,不在迁移框架里、没有 `user_version`。v49 那次已经证明「IF NOT EXISTS 对存量库是空操作」这类错
 * 不进迁移就没人看得见。G1 起每个库都有自己的迁移表(主库 src/lib/db/migrations/,知识库
 * src/adapters/knowledge/migrations/<库>/),生产代码里的 `CREATE [VIRTUAL|TEMP] TABLE` / `ALTER TABLE` / `DROP TABLE`
 * 只许出现在路径里带 `/migrations/` 的文件中。
 *
 * 基线 0、没有豁免表。只扫生产代码(排除 *.test.ts:测试要造旧形状的库);注释行按行跳(块注释正则会吞代码)。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DDL = /\b(?:CREATE\s+(?:VIRTUAL\s+|TEMP\s+|TEMPORARY\s+)?TABLE|ALTER\s+TABLE|DROP\s+TABLE)\b/

export function ddlLines(src: string): number {
  let n = 0
  for (const line of src.split('\n')) {
    if (/^\s*(\/\/|\/\*|\*)/.test(line)) continue
    if (DDL.test(line)) n++
  }
  return n
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(p)
  }
  return out
}

describe('建表 / 改表只在迁移里', () => {
  it('counts DDL statements and skips comment lines', () => {
    expect(ddlLines('db.exec(`CREATE TABLE IF NOT EXISTS t (a)`)')).toBe(1)
    expect(ddlLines('CREATE VIRTUAL TABLE IF NOT EXISTS f USING fts5(text)')).toBe(1)
    expect(ddlLines("db.exec('ALTER TABLE t ADD COLUMN b TEXT')")).toBe(1)
    expect(ddlLines('db.exec(`DROP TABLE t`)')).toBe(1)
    expect(ddlLines('// CREATE TABLE in a comment\n * ALTER TABLE in a doc comment\n/* DROP TABLE */')).toBe(0)
    expect(ddlLines('db.exec(`CREATE INDEX IF NOT EXISTS i ON t(a)`)')).toBe(0)
    expect(ddlLines("db.query('INSERT INTO t VALUES (1)')")).toBe(0)
  })

  it('production code outside **/migrations/** has no table DDL (baseline 0)', () => {
    const offenders: Record<string, number> = {}
    for (const file of [...walk(join(ROOT, 'src')), join(ROOT, 'cli.ts')]) {
      const rel = relative(ROOT, file).split('\\').join('/')
      if (rel.includes('/migrations/')) continue
      const n = ddlLines(readFileSync(file, 'utf8'))
      if (n > 0) offenders[rel] = n
    }
    expect(offenders, '建表 / 改表写成一个迁移:主库 src/lib/db/migrations/,知识库 src/adapters/knowledge/migrations/<库>/(docs/maintainer/migrations.md)').toEqual({})
  })
})
