/**
 * 本地验证一条命令:`bun run verify`(只跑改动牵连到的)/ `bun run verify --full`(跟 CI 一样四条全跑)。
 *
 * 为什么:以前每次改完要敲四条(test / test:node / typecheck / depcheck),全量 5000 多条测试;主人在用机器时
 * 跑全量会把机器压满(docs/maintainer/ci-and-flakes.md),而 CI 反正会把全量、node、三平台再跑一遍。
 * 本地要的是「我这次改的东西有没有弄红」,快出结果;全量是 CI 的事。
 *
 * 默认档做什么(相对 merge-base,基线默认 origin/dev,`--base <ref>` 换):
 *   - 只改了 Markdown ⇒ 什么都不跑(CI 也跳过,见 ci.yml 的 code 输出)。
 *   - typecheck:根项目总是跑;apps/mobile / apps/relay / apps/app 只在它们自己或协议包动过时跑。
 *   - depcheck:总是跑(便宜)。
 *   - 测试:`vitest --changed <base>` —— 按 import 图找到牵连的测试(改了 package.json / vitest 配置 ⇒ vitest 自己
 *     改成全量,forceRerunTriggers,不是这里的 bug);外加**所有守卫**。守卫读的是文件
 *     (readFileSync / 扫目录),不 import 被守的代码,import 图看不见它们,漏了就是安静地少一道闸。
 *     守卫 = scripts/ 下的测试 + 文件名带 guard.test 的 + no-bun-globals + 首行标了 `@repo-guard` 的测试。新守卫照这个起名
 *     或者标上就会被带上。`@repo-guard` 是给住在 src/ 里、跟单测放在一起的仓库级守卫的(#646:read-json-file.test.ts 里
 *     「生产代码不许裸 JSON.parse(readFileSync)」那条没被带上,本地绿、CI 红);scripts/repo-guard-marker.guard.test.ts 查漏标。
 *   - 改了 apps/relay 或协议包 ⇒ 再跑中继自己的单测。
 *   - import 图看不见的输入(.html / .css / .json 这类被测试 readFileSync 的文件)⇒ 点名列出来,
 *     并把源码里提到这个文件名的测试一起跑;Playwright(desktop-e2e)本地不跑,改了桌面看 CI。
 *   - 不跑 node 那一遍(test:node):它测的是「换运行时」,改动牵连判不准,交给 CI;要跑就 --full。
 *   - 真实形状沙盒(`bun run test:sandbox`,src/daemon/__e2e__/real-shaped.ts):每次都跑,两档都跑(本机几秒)。
 *     起整台照真机配置的 daemon(知识库、社交、配对、手机中继 …… 全开),替身只在系统边界。import 图判不出
 *     「这个改动会不会让某个可选子系统开着时开不了机」—— #729 就是这么漏的:单测全绿、真机开机三连败。
 */
import { spawnSync } from 'node:child_process'
import { recordVerified, workingTree } from './verify-stamp'

const argv = process.argv.slice(2)
const full = argv.includes('--full')
const baseArg = argv.indexOf('--base')
const BASE = baseArg >= 0 ? argv[baseArg + 1]! : 'origin/dev'

const git = (args: string[]) => spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const failed: string[] = []
// 开始时就记下检查的是哪份内容(跑的过程中又改了文件,记的仍是开始那份);全绿才记,pre-push 认它(scripts/verify-stamp.ts)
const verifiedTree = (() => { try { return workingTree(process.cwd()) } catch { return null } })()
const stamp = () => { if (verifiedTree) try { recordVerified(process.cwd(), verifiedTree) } catch { /* 记不下只是推的时候要重跑 */ } }

function step(label: string, cmd: string, args: string[], cwd?: string): void {
  console.log(`\n▶ ${label}`)
  const t0 = Date.now()
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd })
  console.log(`  ${r.status === 0 ? '✓' : '✗'} ${label}(${Math.round((Date.now() - t0) / 1000)}s)`)
  if (r.status !== 0) failed.push(label)
}

function finish(): never {
  if (failed.length) {
    console.error(`\n✗ 红了:${failed.join('、')}`)
    process.exit(1)
  }
  stamp()
  console.log(full ? '\n✓ 全量四条都绿。' : '\n✓ 改动牵连到的都绿。全量、node、三平台交给 CI(要本地全跑:bun run verify --full)。')
  process.exit(0)
}

if (full) {
  step('typecheck', 'bun', ['run', 'typecheck'])
  step('depcheck', 'bun', ['run', 'depcheck'])
  step('测试(bun)', 'bun', ['run', 'test'])
  step('测试(node)', 'npm', ['run', 'test:node'])
  step('真实形状沙盒', 'bun', ['run', 'test:sandbox'])
  finish()
}

const mb = git(['merge-base', 'HEAD', BASE])
if (mb.status !== 0) {
  console.error(`✗ 找不到 HEAD 和 ${BASE} 的共同祖先(先 git fetch?或者 --base <ref>)。`)
  process.exit(2)
}
const base = mb.stdout.trim()
const lines = (s: string) => s.split('\n').map(l => l.trim()).filter(Boolean)
const changed = [...new Set([
  ...lines(git(['diff', '--name-only', base]).stdout),
  ...lines(git(['ls-files', '--others', '--exclude-standard']).stdout),
])]

if (changed.length === 0) {
  console.log(`相对 ${BASE} 没有改动,不用跑。`)
  stamp()
  process.exit(0)
}
if (changed.every(f => f.endsWith('.md'))) {
  console.log(`只改了 Markdown(${changed.length} 个文件),不用跑。`)
  stamp()
  process.exit(0)
}

const touched = (...prefixes: string[]) => changed.some(f => prefixes.some(p => f.startsWith(p)))
console.log(`相对 ${BASE}(${base.slice(0, 8)})改了 ${changed.length} 个文件。`)

step('typecheck · 根项目', 'bun', ['x', 'tsc', '--noEmit'])
for (const app of ['apps/mobile', 'apps/relay', 'apps/app']) {
  if (touched(`${app}/`, 'packages/protocol/')) step(`typecheck · ${app}`, 'bun', ['x', 'tsc', '--noEmit', '-p', app])
}
step('depcheck', 'bun', ['run', 'depcheck'])
step('测试 · 改动牵连到的', 'bun', ['--bun', 'vitest', 'run', '--changed', base, '--passWithNoTests'])

const CODE = /\.(ts|tsx|js|mjs|cjs|jsx)$/
const nonImport = changed.filter(f => !CODE.test(f) && !f.endsWith('.md') && !['package.json', 'bun.lock'].includes(f))
if (nonImport.length) {
  console.log(`\nimport 图看不见这些文件:${nonImport.join('、')}`)
  const names = [...new Set(nonImport.map(f => f.split('/').pop()!))]
  const grep = git(['grep', '-lF', ...names.flatMap(n => ['-e', n]), '--', '*.test.ts', '*.test.tsx'])
  const tests = lines(grep.stdout).filter(f => !f.startsWith('apps/app/') && !f.startsWith('apps/relay/'))
  if (tests.length) step(`测试 · 提到这些文件名的(${tests.length})`, 'bun', ['--bun', 'vitest', 'run', ...tests])
  if (touched('apps/desktop/')) console.log('  改了桌面:Playwright 本地不跑,看 CI 的 desktop-e2e(本地要跑:cd apps/desktop && bun x playwright test)。')
}
const marked = lines(git(['grep', '-l', '@repo-guard', '--', 'src/**/*.test.ts']).stdout)
step('测试 · 守卫', 'bun', ['--bun', 'vitest', 'run', 'scripts/', 'guard.test', 'no-bun-globals', ...marked])
step('真实形状沙盒', 'bun', ['run', 'test:sandbox'])
if (touched('apps/relay/', 'packages/protocol/')) step('中继单测', 'bun', ['run', 'test'], 'apps/relay')
finish()
