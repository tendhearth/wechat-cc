/**
 * 模块里 `ctx.late('x')` / `ctx.lazy('x')` 取的名字,必须写在这个模块的 `lazy` 里。
 *
 * 容器(src/daemon/modules/container.ts)只在**调用那一刻**才核,写在 `if (可选子系统起了)` 里的调用测试里根本走不到:
 * 2026-10-26 G5 给 boot-api 加了 `ctx.late('wired')`(在 `if (boot.knowledge)` 里),CI 全绿,真机开机三连败、self deploy 回滚。
 * 所以这里不跑代码,按语法树静态核:找 `{ name: '<字面量>', init(ctx) { … } }` 这样的模块字面量,
 * 收 init 里所有 `<init 的第一个参数>.late|lazy('<字面量>')`,跟 `lazy: [...]` 比。
 * 名字不是字面量的调用也红(认不出来就不放)。只管模块字面量自己的 init;把 ctx 传给别的函数再取的,容器运行时照旧兜着。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) { if (name !== 'node_modules' && name !== '__e2e__') walk(p, out) }
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts')) out.push(p)
  }
  return out
}

function propName(p: ts.ObjectLiteralElementLike): string | undefined {
  return p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : undefined
}

interface Finding { file: string; module: string; problem: string }

function check(file: string): { modules: number; findings: Finding[] } {
  const src = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const rel = relative(ROOT, file).split('\\').join('/')
  const findings: Finding[] = []
  let modules = 0
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const nameProp = node.properties.find(p => propName(p) === 'name')
      const init = node.properties.find(p => propName(p) === 'init')
      const nameInit = nameProp && ts.isPropertyAssignment(nameProp) ? nameProp.initializer : undefined
      const fn = init && (ts.isMethodDeclaration(init) ? init
        : ts.isPropertyAssignment(init) && (ts.isArrowFunction(init.initializer) || ts.isFunctionExpression(init.initializer)) ? init.initializer : undefined)
      const ctxParam = fn?.parameters[0]?.name
      if (nameInit && ts.isStringLiteralLike(nameInit) && fn?.body && ctxParam && ts.isIdentifier(ctxParam)) {
        modules++
        const module = nameInit.text
        const lazyProp = node.properties.find(p => propName(p) === 'lazy')
        const lazy = new Set<string>()
        if (lazyProp && ts.isPropertyAssignment(lazyProp) && ts.isArrayLiteralExpression(lazyProp.initializer)) {
          for (const e of lazyProp.initializer.elements) if (ts.isStringLiteralLike(e)) lazy.add(e.text)
        }
        const scan = (n: ts.Node): void => {
          if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
            && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === ctxParam.text
            && (n.expression.name.text === 'late' || n.expression.name.text === 'lazy')) {
            const arg = n.arguments[0]
            const how = `ctx.${n.expression.name.text}`
            if (!arg || !ts.isStringLiteralLike(arg)) findings.push({ file: rel, module, problem: `${how}(…) 的名字不是字面量` })
            else if (!lazy.has(arg.text)) findings.push({ file: rel, module, problem: `${how}('${arg.text}') 但 lazy 里没有 '${arg.text}'` })
          }
          ts.forEachChild(n, scan)
        }
        scan(fn.body)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(src)
  return { modules, findings }
}

describe('模块晚绑定:取的名字都写在 lazy 里', () => {
  const files = [...walk(join(ROOT, 'src', 'daemon')), ...walk(join(ROOT, 'src', 'features'))]
  const results = files.map(check)
  it('认得出模块(守卫没瞎)', () => {
    expect(results.reduce((n, r) => n + r.modules, 0)).toBeGreaterThan(20)
  })
  it('每个 ctx.late / ctx.lazy 的名字都在本模块的 lazy 里', () => {
    expect(results.flatMap(r => r.findings)).toEqual([])
  })
})
