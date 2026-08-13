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
