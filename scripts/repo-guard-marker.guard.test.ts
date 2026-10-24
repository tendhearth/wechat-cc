/**
 * 住在 src/ 里的仓库级守卫要标 `@repo-guard`,`bun run verify` 才会不管改了什么都跑它。
 *
 * 2026-10-23 #646:src/lib/read-json-file.test.ts 里「生产代码不许裸 JSON.parse(readFileSync)」那条扫的是整个 src,
 * 但它跟单测放在一个文件里、文件名不带 guard.test,verify 的 import 图又看不见它守的文件 ⇒ 本地绿、CI 红。
 * 认法跟 verify 一样简单:测试里既扫目录(readdirSync)、又从测试文件往上找仓库根(`import.meta.url` 往上走 / ROOT 拼 'src')。
 * 认错了(只是读自己的夹具目录)就标上也无妨 —— 多跑一份小测试,比安静地少一道闸便宜。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCANS_DIR = /\breaddirSync\(/
const FINDS_ROOT = /(ROOT|REPO_ROOT|repoRoot)[^\n]*'src'|import\.meta\.url\)[^\n]*'\.\.'|join\(__dirname, '\.\.'/

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (name.endsWith('.test.ts')) out.push(p)
  }
  return out
}

describe('src 里的仓库级守卫都标了 @repo-guard', () => {
  it('扫目录又找仓库根的测试,文件里要有 @repo-guard', () => {
    const missing = walk(join(ROOT, 'src'))
      .filter(f => { const t = readFileSync(f, 'utf8').replace(/\r\n/g, '\n'); return SCANS_DIR.test(t) && FINDS_ROOT.test(t) && !t.includes('@repo-guard') })
      .map(f => relative(ROOT, f).split('\\').join('/'))
    expect(missing, '在文件第一行加 // @repo-guard <一句话>,verify 才会每次都跑它').toEqual([])
  })
})
