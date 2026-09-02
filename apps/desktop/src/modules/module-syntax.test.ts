/**
 * 桌面端模块的加载健全性 —— 只查一件事:同一个标识符有没有既被 import
 * 又在本文件里声明。
 *
 * 2026-08-31 的真实事故:给 a2a-agents.js 加了 `import { escapeHtml }`,而
 * 该文件 1182 行【本来就有】一个同名的本地 `function escapeHtml`。重复声明
 * 是 SyntaxError,整个模块加载失败 ⇒ dashboard 起不来 ⇒ 所有需要启动
 * dashboard 的 playwright spec 全部挂死(csp.spec 这类不启动的照常秒过)。
 *
 * 为什么单测和 tsc 都没拦住:vitest 只转译不做模块级重复声明检查,tsc 对
 * 这个 .js 文件也没报。**唯一的症状是 e2e 集体超时**,而超时最容易被当成
 * "机器慢/环境问题"糊弄过去 —— 我当时差点就那么归因了。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = dirname(fileURLToPath(import.meta.url))

/** 从 `import { a, b as c } from '...'` 里取出本地绑定名。 */
function importedNames(src: string): string[] {
  const out: string[] = []
  for (const m of src.matchAll(/^import\s*\{([^}]*)\}\s*from\s*['"][^'"]+['"]/gm)) {
    for (const part of m[1]!.split(',')) {
      const t = part.trim()
      if (!t) continue
      const as = t.match(/\bas\s+([A-Za-z_$][\w$]*)$/)
      out.push(as ? as[1]! : t.replace(/^type\s+/, ''))
    }
  }
  return out
}

/** 本文件顶层声明的函数/常量名。 */
function declaredNames(src: string): string[] {
  return [...src.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1]!)
    .concat([...src.matchAll(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1]!))
}

describe('桌面端模块:import 名与本地声明名不得撞车', () => {
  const files = readdirSync(DIR).filter(f => f.endsWith('.js'))

  it('每个模块都被检查到(防止用例空跑)', () => {
    expect(files.length).toBeGreaterThan(3)
  })

  for (const f of files) {
    it(`${f} 没有重复声明`, () => {
      const src = readFileSync(join(DIR, f), 'utf8')
      const dupes = importedNames(src).filter(n => declaredNames(src).includes(n))
      expect(dupes, `${f} 里这些名字既 import 又本地声明,会是 SyntaxError`).toEqual([])
    })
  }
})
