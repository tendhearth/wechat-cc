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
 *   - 测试:`vitest --changed <base>` —— 按 import 图找到牵连的测试;外加**所有守卫**。守卫读的是文件
 *     (readFileSync / 扫目录),不 import 被守的代码,import 图看不见它们,漏了就是安静地少一道闸。
 *     守卫 = scripts/ 下的测试 + 文件名带 guard.test 的 + no-bun-globals。新守卫照这个起名就会被带上。
 *   - 改了 apps/relay 或协议包 ⇒ 再跑中继自己的单测。
 *   - 不跑 node 那一遍(test:node):它测的是「换运行时」,改动牵连判不准,交给 CI;要跑就 --full。
 */
import { spawnSync } from 'node:child_process'

const argv = process.argv.slice(2)
const full = argv.includes('--full')
const baseArg = argv.indexOf('--base')
const BASE = baseArg >= 0 ? argv[baseArg + 1]! : 'origin/dev'

const git = (args: string[]) => spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const failed: string[] = []

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
  console.log(full ? '\n✓ 全量四条都绿。' : '\n✓ 改动牵连到的都绿。全量、node、三平台交给 CI(要本地全跑:bun run verify --full)。')
  process.exit(0)
}

if (full) {
  step('typecheck', 'bun', ['run', 'typecheck'])
  step('depcheck', 'bun', ['run', 'depcheck'])
  step('测试(bun)', 'bun', ['run', 'test'])
  step('测试(node)', 'npm', ['run', 'test:node'])
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
  process.exit(0)
}
if (changed.every(f => f.endsWith('.md'))) {
  console.log(`只改了 Markdown(${changed.length} 个文件),不用跑。`)
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
step('测试 · 守卫', 'bun', ['--bun', 'vitest', 'run', 'scripts/', 'guard.test', 'no-bun-globals'])
if (touched('apps/relay/', 'packages/protocol/')) step('中继单测', 'bun', ['run', 'test'], 'apps/relay')
finish()
