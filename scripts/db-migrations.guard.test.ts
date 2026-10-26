/**
 * 迁移的位置就是契约(第三批 3e,设计稿 docs/superpowers/specs/2026-10-23-db-migrations-per-file-design.md §4)。
 *
 * `PRAGMA user_version` 记的是「跑了几个」,不是哪几个 —— 第 i 项被挪动、插队、改名,已经过了那一位的库就会和 #79 一样错位。
 * 这条守卫钉三件事:
 *  1. index.ts 里 `migrations` 的第 i 项就是 `v{i 补零到三位}`,并且正是从 `./v{i}` import 来的;
 *  2. 目录里的 v*.ts 编号从 001 连续、不跳号、不重号,个数等于 `migrations.length`(多一个文件不能悄悄变成多一个迁移,
 *     少登记一个也红);
 *  3. 每个迁移文件只导出一个 `migration`。
 * 两路各自加了 v085.ts ⇒ git 报同名文件冲突(以前是数组末尾各加一项、git 静默合成 v85 / v86)。
 * 知识库的四个库(架构终态 G1:source / semantic / graph / facts)各有一张迁移表,在 src/adapters/knowledge/migrations/<库>/,
 * 同样钉这三件事(文件末尾那一段)。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrations, type Migration } from '../src/lib/db'
import { migrations as knowledgeSource } from '../src/adapters/knowledge/migrations/source'
import { migrations as knowledgeSemantic } from '../src/adapters/knowledge/migrations/semantic'
import { migrations as knowledgeGraph } from '../src/adapters/knowledge/migrations/graph'
import { migrations as knowledgeFacts } from '../src/adapters/knowledge/migrations/facts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIR = join(ROOT, 'src', 'lib', 'db', 'migrations')
const pad = (i: number) => String(i).padStart(3, '0')

describe('迁移一版一个文件:文件名 = 位置', () => {
  const files = readdirSync(DIR).filter(f => /^v\d+\.ts$/.test(f)).sort()
  const index = readFileSync(join(DIR, 'index.ts'), 'utf8')

  it('the files are v001…vN with no gaps or duplicates, and N equals migrations.length', () => {
    expect(files).toEqual(Array.from({ length: files.length }, (_, k) => `v${pad(k + 1)}.ts`))
    expect(migrations.length).toBe(files.length)
  })

  it('index.ts lists them in order: the i-th entry is v{i}, imported from ./v{i}', () => {
    const body = index.slice(index.indexOf('export const migrations'))
    const entries = [...body.matchAll(/^\s+(v\d{3}),$/gm)].map(m => m[1])
    expect(entries).toEqual(files.map(f => f.replace(/\.ts$/, '')))
    const imports = [...index.matchAll(/^import \{ migration as (v\d{3}) \} from '\.\/(v\d{3})'$/gm)].map(m => [m[1], m[2]])
    expect(imports.every(([as, from]) => as === from)).toBe(true)
    expect(imports.map(([as]) => as)).toEqual(entries)
  })

  // 3e 迁移第 3 步:v001–v084 里有一批「为测试让路」的守卫(表在不在 / 列在不在),是给手写的假 v9 / v26 库加的。假库已经改成
  // 从真迁移起步(db.test.ts 的 migratedTo),老守卫留着不改(进了 dev 的迁移一字不改)。从 v085 起不许再写这种守卫:
  // 测试要哪个版本的库,用 migratedTo(n) 造真的,别让迁移迁就测试。
  it('migrations from v085 on do not carry test-accommodation guards', () => {
    const FROM = 85
    const SMELLS = /起跑的夹具|从 user_version ?= ?\d+ 起|user_version ?= ?\d+ (test )?harness|test harness|unit-test harnesses|单测库/
    for (const f of files) {
      if (Number(f.slice(1, 4)) < FROM) continue
      expect(readFileSync(join(DIR, f), 'utf8'), `${f}: 测试要旧版本的库,用 migratedTo(n) 从真迁移造,别在迁移里为测试加守卫`).not.toMatch(SMELLS)
    }
  })

  it('each migration file exports exactly one `migration`', () => {
    for (const f of files) {
      const src = readFileSync(join(DIR, f), 'utf8')
      expect([...src.matchAll(/^export /gm)].length, f).toBe(1)
      expect(src, f).toMatch(/^export const migration: Migration = /m)
    }
  })
})

const KNOWLEDGE: Array<[string, readonly Migration[]]> = [
  ['source', knowledgeSource], ['semantic', knowledgeSemantic], ['graph', knowledgeGraph], ['facts', knowledgeFacts],
]
for (const [lib, list] of KNOWLEDGE) {
  describe(`知识库 ${lib}.db 的迁移:文件名 = 位置`, () => {
    const dir = join(ROOT, 'src', 'adapters', 'knowledge', 'migrations', lib)
    const files = readdirSync(dir).filter(f => /^v\d+\.ts$/.test(f)).sort()
    const index = readFileSync(join(dir, 'index.ts'), 'utf8')

    it('the files are v001…vN with no gaps or duplicates, and N equals the list length', () => {
      expect(files.length).toBeGreaterThan(0)
      expect(files).toEqual(Array.from({ length: files.length }, (_, k) => `v${pad(k + 1)}.ts`))
      expect(list.length).toBe(files.length)
    })

    it('index.ts lists them in order: the i-th entry is v{i}, imported from ./v{i}', () => {
      const body = index.slice(index.indexOf('export const migrations'))
      const entries = [...body.matchAll(/^\s+(v\d{3}),$/gm)].map(m => m[1])
      expect(entries).toEqual(files.map(f => f.replace(/\.ts$/, '')))
      const imports = [...index.matchAll(/^import \{ migration as (v\d{3}) \} from '\.\/(v\d{3})'$/gm)].map(m => [m[1], m[2]])
      expect(imports.every(([as, from]) => as === from)).toBe(true)
      expect(imports.map(([as]) => as)).toEqual(entries)
    })

    it('each migration file exports exactly one `migration` and carries no test-accommodation guard', () => {
      for (const f of files) {
        const src = readFileSync(join(dir, f), 'utf8')
        expect([...src.matchAll(/^export /gm)].length, f).toBe(1)
        expect(src, f).toMatch(/^export const migration: Migration = /m)
        expect(src, f).not.toMatch(/起跑的夹具|test harness|unit-test harnesses|单测库/)
      }
    })
  })
}
