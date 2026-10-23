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
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrations } from '../src/lib/db'

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

  it('each migration file exports exactly one `migration`', () => {
    for (const f of files) {
      const src = readFileSync(join(DIR, f), 'utf8')
      expect([...src.matchAll(/^export /gm)].length, f).toBe(1)
      expect(src, f).toMatch(/^export const migration: Migration = /m)
    }
  })
})
