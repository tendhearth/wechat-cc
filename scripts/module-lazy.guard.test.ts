/**
 * 模块里 `ctx.late('x')` / `ctx.lazy('x')` 取的名字,必须写在这个模块的 `lazy` 里。
 *
 * 容器(src/daemon/modules/container.ts)只在**调用那一刻**才核,写在 `if (可选子系统起了)` 里的调用测试里根本走不到:
 * 2026-10-26 G5 给 boot-api 加了 `ctx.late('wired')`(在 `if (boot.knowledge)` 里),CI 全绿,真机开机三连败、self deploy 回滚。
 * 所以这里不跑代码,按语法树静态核:找 `{ name: '<字面量>', init(ctx) { … } }` 这样的模块字面量,
 * 收 init 里所有 `<init 的第一个参数>.late|lazy('<字面量>')`,跟 `lazy: [...]` 比。
 * 名字不是字面量的调用也红(认不出来就不放)。只管模块字面量自己的 init;把 ctx 传给别的函数再取的,容器运行时照旧兜着。
 *
 * 还认第二种形状:交给模块工厂的**选项字面量**(`memoryFeature({ lazy: [...], deps: (ctx) => { … ctx.late('wired') … } })`、
 * `bootstrapModules({ … })`)。工厂把 `lazy` 原样转进模块,`deps` 在模块的 init 里被调 —— 字面量上看不到 `name` / `init`,
 * 以前这一种整个没核(2026-10-26 各功能的接线搬进 `src/features/<名>/module.ts` 时补上)。规则同上:字面量里第一个参数
 * 是标识符的函数(方法 / 箭头 / function 表达式),里面 `<参数>.late|lazy('x')` 的 x 必须在这个字面量的 `lazy` 里。
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

/** fn 的 body 里所有 `<第一个参数>.late|lazy(…)`,跟 lazy 比。返回找到几处;fn 不是「第一个参数是标识符」的形状 ⇒ null。 */
function scanLate(fn: ts.SignatureDeclaration & { body?: ts.Node }, lazy: Set<string>, push: (problem: string) => void): number | null {
  const ctxParam = fn.parameters[0]?.name
  if (!fn.body || !ctxParam || !ts.isIdentifier(ctxParam)) return null
  let calls = 0
  const scan = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
      && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === ctxParam.text
      && (n.expression.name.text === 'late' || n.expression.name.text === 'lazy')) {
      const arg = n.arguments[0]
      const how = `ctx.${n.expression.name.text}`
      calls++
      if (!arg || !ts.isStringLiteralLike(arg)) push(`${how}(…) 的名字不是字面量`)
      else if (!lazy.has(arg.text)) push(`${how}('${arg.text}') 但 lazy 里没有 '${arg.text}'`)
    }
    ts.forEachChild(n, scan)
  }
  scan(fn.body)
  return calls
}

function lazyOf(node: ts.ObjectLiteralExpression): Set<string> {
  const lazyProp = node.properties.find(p => propName(p) === 'lazy')
  const lazy = new Set<string>()
  if (lazyProp && ts.isPropertyAssignment(lazyProp) && ts.isArrayLiteralExpression(lazyProp.initializer)) {
    for (const e of lazyProp.initializer.elements) if (ts.isStringLiteralLike(e)) lazy.add(e.text)
  }
  return lazy
}

/**
 * 选项字面量自己没写 `lazy`、而是被展开进外面那个字面量的(`...(hasApi ? { api: (ctx) => … } : {})`)⇒ 按外面那个的 lazy 核:
 * 工厂收到的是展开后的一整个选项。
 */
function spreadInto(node: ts.ObjectLiteralExpression): ts.ObjectLiteralExpression | undefined {
  let n: ts.Node = node.parent
  while (n && (ts.isParenthesizedExpression(n) || ts.isConditionalExpression(n))) n = n.parent
  return n && ts.isSpreadAssignment(n) && ts.isObjectLiteralExpression(n.parent) ? n.parent : undefined
}

/** 字面量属性上的函数:方法、`k: (x) => …`、`k: function (x) { … }`。 */
function fnOf(p: ts.ObjectLiteralElementLike): (ts.SignatureDeclaration & { body?: ts.Node }) | undefined {
  if (ts.isMethodDeclaration(p)) return p
  if (ts.isPropertyAssignment(p) && (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer))) return p.initializer
  return undefined
}

/** 选项字面量叫什么(报错用):外面那个调用的函数名。 */
function calleeOf(node: ts.Node): string {
  const call = node.parent
  if (call && ts.isCallExpression(call)) {
    const e = call.expression
    if (ts.isIdentifier(e)) return e.text
    if (ts.isPropertyAccessExpression(e)) return e.name.text
  }
  return '(选项字面量)'
}

function check(file: string): { modules: number; options: number; findings: Finding[] } {
  const src = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const rel = relative(ROOT, file).split('\\').join('/')
  const findings: Finding[] = []
  let modules = 0
  let options = 0
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const nameProp = node.properties.find(p => propName(p) === 'name')
      const init = node.properties.find(p => propName(p) === 'init')
      const nameInit = nameProp && ts.isPropertyAssignment(nameProp) ? nameProp.initializer : undefined
      const fn = init && fnOf(init)
      if (nameInit && ts.isStringLiteralLike(nameInit) && fn) {
        const module = nameInit.text
        if (scanLate(fn, lazyOf(node), problem => findings.push({ file: rel, module, problem })) !== null) modules++
      } else {
        // 选项字面量:里面哪个函数用第一个参数取了 late / lazy,就按这个字面量的 lazy 核。
        let outer: ts.ObjectLiteralExpression = node
        while (!outer.properties.some(p => propName(p) === 'lazy')) { const o = spreadInto(outer); if (!o) break; outer = o }
        const lazy = lazyOf(outer)
        const module = calleeOf(outer)
        let calls = 0
        for (const p of node.properties) {
          const f = fnOf(p)
          if (f) calls += scanLate(f, lazy, problem => findings.push({ file: rel, module, problem })) ?? 0
        }
        if (calls > 0) options++   // 真取了 late / lazy 的才算(给「守卫没瞎」那一条数)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(src)
  return { modules, options, findings }
}

describe('模块晚绑定:取的名字都写在 lazy 里', () => {
  const files = [...walk(join(ROOT, 'src', 'daemon')), ...walk(join(ROOT, 'src', 'features'))]
  const results = files.map(check)
  it('认得出模块(守卫没瞎)', () => {
    expect(results.reduce((n, r) => n + r.modules, 0)).toBeGreaterThan(20)
  })
  it('认得出交给模块工厂的选项字面量(memoryFeature / bootstrapModules …:守卫没瞎)', () => {
    expect(results.reduce((n, r) => n + r.options, 0)).toBeGreaterThan(5)
  })
  it('每个 ctx.late / ctx.lazy 的名字都在本模块的 lazy 里', () => {
    expect(results.flatMap(r => r.findings)).toEqual([])
  })
})
