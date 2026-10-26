/**
 * 桌面的 JS 都开着 `// @ts-check`,而且真的在 tsc 的程序里(架构终态 F5)。
 *
 * apps/desktop/src 是纯 JS(webview 直接加载,不过构建)。类型检查靠两样一起:文件头的 `// @ts-check`,
 * 加上根 tsconfig.json 的 include 收了它 —— 只有前者、文件又没人从 .ts 里 import,tsc 根本不看它,
 * 写了 `@ts-check` 也是白写(2026-10-25 之前 aquarium-atlas.js / pet-lab.js 就是这样)。
 * 零基线:新加的 .js 不写 `// @ts-check` 就红。
 * 不扫:测试(`*.test.js`)、生成物 `src/generated/`、第三方压缩包 `src/vendor/`(压缩过的 marked / fflate,不是我们写的)。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DESKTOP_SRC = join(ROOT, 'apps/desktop/src')
const SKIP_DIRS = ['generated', 'vendor', 'node_modules']

/** 文件开头的注释段(代码之前)里有一行 `// @ts-check` —— tsc 只认代码之前的那一行。 */
function hasTsCheck(text: string): boolean {
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const t = line.trim()
    if (/^\/\/\s*@ts-check\b/.test(t)) return true
    if (t === '' || t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('*/')) continue
    return false
  }
  return false
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) { if (!SKIP_DIRS.includes(name)) walk(p, out) }
    else if (name.endsWith('.js') && !name.endsWith('.test.js')) out.push(p)
  }
  return out
}

describe('桌面 JS 都开着 @ts-check', () => {
  it('apps/desktop/src 里(测试、生成物、vendor 除外)每个 .js 开头的注释段里都有 // @ts-check', () => {
    const files = walk(DESKTOP_SRC)
    expect(files.length).toBeGreaterThan(50)
    const missing = files
      .filter(f => !hasTsCheck(readFileSync(f, 'utf8')))
      .map(f => relative(ROOT, f).split('\\').join('/'))
    expect(missing, '在文件第一行加 // @ts-check(要 DOM 类型再加 /// <reference lib="dom" />),报错用 JSDoc 修').toEqual([])
  })

  it('根 tsconfig.json 把 apps/desktop/src 的 .js 都收进程序(不然 @ts-check 没人看)', () => {
    const tsconfig = JSON.parse(readFileSync(join(ROOT, 'tsconfig.json'), 'utf8')) as { include?: string[], exclude?: string[], compilerOptions?: { allowJs?: boolean } }
    expect(tsconfig.compilerOptions?.allowJs).toBe(true)
    expect(tsconfig.include ?? []).toContain('apps/desktop/src/**/*.js')
    expect((tsconfig.exclude ?? []).filter(e => e.startsWith('apps/desktop/src/'))).toEqual([])
  })
})
