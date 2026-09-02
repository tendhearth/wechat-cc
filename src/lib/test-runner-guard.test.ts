import { expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// Why this test exists:
//
// This repo runs vitest, and only vitest: `bun run test` is
// `bun --bun vitest run`, and CI's three required `build ·` jobs run that
// same script. There is no `bun test` entry point.
//
// A test file that imports from 'bun:test' therefore never executes its
// assertions. vitest collects it and dies at import with
//
//     Cannot use describe outside of the test runner. Run "bun test" to run tests.
//
// which is worse than useless as a diagnostic: it reads like harness noise,
// and its advice ("run bun test") is wrong for this repo. During the
// Knowledge Kernel work six suites — src/core/knowledge/{graph,facts,person}
// .test.ts, src/core/peer-closeness.test.ts, src/daemon/social/
// owner-grounding.test.ts, src/daemon/companion/knowledge-distill.test.ts —
// sat in exactly that state for a whole feature's lifetime, 52 assertions
// that had never run once, while required CI stayed red and the message was
// read as infrastructure trouble. Caught by the v1.3.8 pre-tag gate
// (2026-08-13); switching each import to 'vitest' was the entire fix.
//
// So this guard does not add detection vitest lacked — vitest already fails
// the run. It replaces a misleading message with a named one, so the next
// person sees "you imported bun:test, change it to vitest" instead of being
// told to switch runners.

const SELF = fileURLToPath(import.meta.url)

const REPO_ROOT = (() => {
  const here = dirname(SELF)
  // src/lib/ → repo root
  return join(here, '..', '..')
})()

function* walkTestFiles(dir: string): Generator<string> {
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return }
  for (const ent of entries) {
    if (ent === 'node_modules' || ent === '.git' || ent === 'dist' || ent === 'target') continue
    const p = join(dir, ent)
    if (statSync(p).isDirectory()) {
      yield* walkTestFiles(p)
      continue
    }
    if (p.endsWith('.test.ts')) yield p
  }
}

// Everywhere a *.test.ts currently lives. `eval/` is excluded on purpose:
// vitest.config.ts excludes it from collection, so a bun:test import there
// is inert rather than a never-run suite.
const SCAN_ROOTS = ['src', 'apps', 'relay']

function* scanTestFiles(): Generator<string> {
  for (const root of SCAN_ROOTS) yield* walkTestFiles(join(REPO_ROOT, root))
  // Root-level suites (update.test.ts, update.e2e.test.ts, ...) sit beside
  // the CLI entry points rather than under src/.
  for (const ent of readdirSync(REPO_ROOT)) {
    if (ent.endsWith('.test.ts')) yield join(REPO_ROOT, ent)
  }
}

const BUN_TEST_IMPORT = /(?:from|require\()\s*['"]bun:test['"]/

it('no test file imports from bun:test — this repo runs vitest only, so such a file never executes', () => {
  const offenders: string[] = []
  for (const file of scanTestFiles()) {
    // Skip this file: the prose above and the pattern below both contain the
    // literal it searches for, so the scanner would flag itself.
    if (file === SELF) continue
    if (BUN_TEST_IMPORT.test(readFileSync(file, 'utf8'))) {
      offenders.push(relative(REPO_ROOT, file))
    }
  }
  expect(
    offenders,
    offenders.length === 0
      ? ''
      : `These test files import from 'bun:test', so vitest cannot run them and their `
        + `assertions never execute:\n  ${offenders.join('\n  ')}\n`
        + `Change the import to 'vitest'. describe/it/test/expect are API-compatible; `
        + `bun's \`mock\` has no direct equivalent — use vi.mock / vi.fn instead.`,
  ).toEqual([])
})

it('finds the test files it is supposed to be scanning (guards against a silently empty scan)', () => {
  // A path/root regression that made scanTestFiles() yield nothing would make
  // the check above pass vacuously — which is the same class of failure it
  // exists to prevent.
  const count = [...scanTestFiles()].length
  expect(count).toBeGreaterThan(100)
})

// 第二类「本地绿、别的平台红」:POSIX 文件权限断言。
//
// Windows 没有 POSIX mode 的概念,`statSync().mode & 0o777` 在那里恒为
// 0o666(438),于是任何 `toBe(0o600)`(384)必然失败。仓库里这类断言散在
// 五处,守卫写法还有两种(`if (win32) return` 与 `if (!win32) { … }`)——
// **时有时无、全靠人记得**,而 macOS 上本地跑永远看不出来。
//
// 2026-09-01 就这么漏了一条:social-enable.test.ts 的「原子写 + 0600」少了
// 守卫,dev 的 windows-latest 连红三次(`expected 438 to be 384`),而
// ubuntu/macOS 全绿 —— 与 [[macos-only-green-blind-spot]] 同一类盲区。
//
// 判定按 it/test 块粒度而不是文件粒度:同一个文件里可以一条守了、另一条
// 没守,正是漏掉的那次的样子。
const MODE_ASSERTION = /mode\s*&\s*0o777|toBe\(0o[67]00\)/
const PLATFORM_GUARD = /win32/

it('每个断言 POSIX 文件权限的用例都带平台守卫 —— Windows 上 mode 恒为 0o666', () => {
  const offenders: string[] = []
  for (const file of scanTestFiles()) {
    if (file === SELF) continue
    const src = readFileSync(file, 'utf8')
    if (!MODE_ASSERTION.test(src)) continue
    // 按 it(/test( 切块:同一文件里守卫可能只加了一半。
    const blocks = src.split(/\n(?=\s*(?:it|test)\()/)
    for (const block of blocks) {
      if (MODE_ASSERTION.test(block) && !PLATFORM_GUARD.test(block)) {
        const title = block.match(/(?:it|test)\(\s*['"`](.*?)['"`]/)?.[1] ?? '(未命名用例)'
        offenders.push(`${relative(REPO_ROOT, file)} — ${title}`)
      }
    }
  }
  expect(
    offenders,
    offenders.length === 0
      ? ''
      : `这些用例断言了 POSIX 文件权限却没有平台守卫,在 Windows CI 上必然报 `
        + `\`expected 438 to be 384\`:\n  ${offenders.join('\n  ')}\n`
        + `加一行 \`if (process.platform === 'win32') return\` —— Windows 没有 POSIX mode,`
        + `这个断言在那里没有意义。`,
  ).toEqual([])
})
