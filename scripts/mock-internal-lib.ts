/**
 * 「mock 只许替身系统边界」的纯逻辑(守卫在 scripts/mock-internal.guard.test.ts,规矩在 docs/maintainer/verify.md)。
 *
 * 认的 mock:`vi.mock(<spec>, …)`、`vi.doMock(<spec>, …)`、bun 的 `mock.module(<spec>, …)`。
 * `vi.fn()` / 经参数注入的假实现不算 —— 那正是我们要的写法。
 *
 * spec 按所在文件解析成仓库里的路径,再分两类:
 *  - **边界(放行)**:node 内置(`node:x` / 裸 `fs`)、`bun:x`、npm 包(含各家 SDK)、`src/adapters/**`(adapters 层就是
 *    我们包在外部系统外面的那层壳,mock 它等于在边界上替身)、`src/test-support/**`、`*.test-support.*`,
 *    以及 BOUNDARY_FILES 里逐条写了理由的「住在 adapters 外面的真边界」。
 *  - **内部(计数)**:解析进仓库的其余一切 —— src/domain、src/app、src/features、src/daemon、src/lib、src/ports、src/cli、
 *    src/mcp-servers、packages/*(含裸写的 `@wechat-cc/x`)、apps/*\/src、scripts、relay …
 *    apps 也按这条:App / 桌面自己的 hooks、组件、视图帮手都是内部;它们跟外界(原生 SDK、daemon 进程)之间那层壳才是边界。
 *  - spec 不是字面量(变量、拼接、带 `${}` 的模板):认不出来就不放,算内部。
 *
 * 注释按行跳过(`//`、`*`、`/*` 开头的行),不用块注释正则 —— 字符串里的 `/*`(glob)会把后面的真代码吞掉、静默少报。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, join, posix, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 住在 adapters 外面、但确实是系统边界的模块(仓库相对路径,不带扩展名)。每条写明为什么;文件没了守卫会红。 */
export const BOUNDARY_FILES: Record<string, string> = {
  'src/lib/ilink': 'ilink(微信服务器)的 HTTP 传输层,文件头写明只管怎么跟 ilink 说话、没有业务逻辑',
  'apps/desktop/src/api': '桌面页面到 daemon /v1 的 HTTP 口子:对面是另一个进程',
  'apps/app/src/push/native': 'expo-notifications / 钥匙串的真实例;纯逻辑在 register.ts / key-store.ts',
  'apps/app/src/ui/talk-recorder': 'expo-audio 录音的真实例(TalkRecorder 接口在 state/hold-to-talk)',
}

const BOUNDARY_DIRS = ['src/adapters/', 'src/test-support/']
const SKIP_DIRS = new Set(['node_modules', '.git', '.claude', 'vendor', 'generated', 'target', 'dist', 'build', 'Pods', '.expo', 'coverage', 'native', 'docs'])
const CODE = /\.(m?[jt]sx?)$/
const MOCK_HEAD = /\b(?:vi\.(?:mock|doMock)|mock\.module)\(\s*/g
const BUILTINS = new Set(builtinModules)

export interface MockCall { line: number; spec: string | null }
export interface Classified { internal: boolean; target: string }

/** 一个文件里所有 mock 调用;spec 不是字面量时为 null。注释行不算。 */
export function findMocks(text: string): MockCall[] {
  const out: MockCall[] = []
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!
    if (/^\s*(\/\/|\*|\/\*)/.test(l)) continue
    for (const m of l.matchAll(MOCK_HEAD)) {
      // 参数可能换到下一行:接上后面一行再读
      const rest = l.slice(m.index! + m[0].length) + '\n' + (lines[i + 1] ?? '')
      const lit = /^\s*(['"`])((?:(?!\1)[^\\\n]|\\.)*)\1/.exec(rest)
      const spec = lit && !(lit[1] === '`' && lit[2]!.includes('${')) ? lit[2]! : null
      out.push({ line: i + 1, spec })
    }
  }
  return out
}

/** `fromRel`:mock 所在文件的仓库相对路径(正斜杠)。 */
export function classify(fromRel: string, spec: string | null): Classified {
  if (spec === null) return { internal: true, target: '<非字面量>' }
  if (spec.startsWith('node:') || spec.startsWith('bun:') || BUILTINS.has(spec.split('/')[0]!)) return { internal: false, target: spec }
  const ws = /^@wechat-cc\/([^/]+)/.exec(spec)
  if (ws) return { internal: true, target: `packages/${ws[1]}` }
  let target: string
  if (spec.startsWith('.')) target = posix.normalize(posix.join(posix.dirname(fromRel), spec))
  else if (spec.startsWith('/')) target = '<绝对路径>'
  else return { internal: false, target: spec } // npm 包
  target = target.replace(CODE, '').replace(/\/index$/, '')
  if (target.startsWith('..') || target.startsWith('<')) return { internal: true, target } // 出了仓库:认不出来就不放
  if (BOUNDARY_DIRS.some(d => target.startsWith(d)) || /\.test-support$/.test(target) || target in BOUNDARY_FILES) return { internal: false, target }
  return { internal: true, target }
}

function walk(dir: string, out: string[]): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) { if (!SKIP_DIRS.has(name)) walk(p, out) }
    else if (CODE.test(name) && !name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

/** 全仓库扫一遍(测试、`__e2e__` 的 fake、vitest.setup 都在内):文件 → 内部 mock 的目标列表。 */
export function scanInternalMocks(root = ROOT, skip: string[] = []): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const abs of walk(root, [])) {
    const rel = relative(root, abs).split('\\').join('/')
    if (skip.includes(rel)) continue
    const text = readFileSync(abs, 'utf8')
    if (!/\b(vi\.(mock|doMock)|mock\.module)\(/.test(text)) continue
    for (const m of findMocks(text)) {
      const c = classify(rel, m.spec)
      if (c.internal) (out[rel] ??= []).push(c.target)
    }
  }
  return out
}
