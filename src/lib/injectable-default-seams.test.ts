import { expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// Why this test exists.
//
// The repo makes host interactions injectable — `const spawnFn = opts.spawnFn
// ?? defaultSpawn` — which is good design and makes the units testable. The
// failure mode is what happens next: every test injects, so the DEFAULT is
// the one code path nothing ever runs, and production runs only the default.
//
// That cost two real bugs in one day (2026-08-14):
//
//   defaultSpawnBun   spawned a bare `bun`, unresolvable under a launchd
//                     PATH, so the codex SDK auto-realign had never once run.
//   defaultSpawn      spawned the embed subprocess as a bare script, so its
//                     package-relative imports raised, so wechat's semantic
//                     index had never been built — including in released
//                     desktop-v1.3.8.
//
// Both were found by hand, by accident, months after shipping. Neither test
// suite was wrong about what it asserted; both simply never touched the
// default.
//
// So: every `?? defaultX` seam must be classified, once, by whoever adds it.
// A new seam that is neither in BOUNDARY nor in PURE fails this test with the
// file and name, and the author has to decide which it is.
//
// What this buys, precisely: it forces the classification decision to happen
// at authoring time. It does NOT prove the default is exercised well — a
// BOUNDARY entry is satisfied by a test file merely naming it. Treat a green
// run as "someone thought about this seam", not as "this seam is covered".

const SELF = fileURLToPath(import.meta.url)
const REPO_ROOT = join(dirname(SELF), '..', '..')

/** Seams that cross a process/IO boundary: spawn, network, dynamic import,
 *  filesystem probing. These must be named by at least one test file — the
 *  test is expected to drive the real default, not a stand-in. */
const BOUNDARY: Record<string, string> = {
  defaultSpawn: 'spawns the embed subprocess (src/core/knowledge/embed-runner.ts)',
  defaultSpawnBun: 'spawns `bun add` to realign the codex SDK (src/lib/codex-autofix.ts)',
  defaultImporter: 'dynamic import of the hearth MCP client (src/daemon/hearth-adapter.ts)',
  defaultPipelineFactory: 'dynamic import of transformers.js + ONNX model load (src/core/knowledge/js-embedder.ts)',
  defaultFetchBinary: 'downloads a release binary over the network (src/cli/setup-flow.ts)',
  defaultProbeCursor: 'spawns the cursor CLI to read its version (src/cli/doctor.ts)',
  defaultProbeGemini: 'spawns the gemini CLI to read its version (src/cli/doctor.ts)',
  defaultSpawnFn: 'spawns the agy (Antigravity) CLI child process per turn (src/core/agy-agent-provider.ts)',
}

/** Seams whose default is a plain value or a pure computation — injecting one
 *  is a convenience, and the default cannot fail in an environment-specific
 *  way. Exempt, with the reason recorded so the exemption is a decision
 *  rather than a shrug. */
const PURE: Record<string, string> = {
  defaultMode: 'returns a Mode literal',
  defaultBotId: 'a string id used by the e2e harness',
  defaultOpenaiModel: 'a model-name string',
  defaultModel: 'a model-name string',
  defaultProviderId: 'a provider-name string',
  defaultClaudeProjectsRoot: 'joins a path; no IO at the seam itself',
  defaultSleep: 'setTimeout wrapper',
  defaultModelRepo: 'maps a model id to a HF repo string; no IO',
  defaultIsWritable: 'a single accessSync, already covered by codex-autofix tests',
}

/** Escape hatch for a BOUNDARY entry no hermetic test can drive.
 *
 * Deliberately empty. It was first populated with defaultFetchBinary,
 * defaultProbeCursor and defaultProbeGemini on the assumption that they need
 * the network or a third-party binary — an assumption made from their names,
 * and wrong on all three. The probes only read an env var and call
 * `createRequire().resolve()`, so they run anywhere; defaultFetchBinary does
 * a real fetch, but a `Bun.serve` on 127.0.0.1 is real HTTP with nothing
 * external to be flaky about.
 *
 * Read the implementation before adding anything here. "Crosses a boundary"
 * is not the same as "cannot be tested", and the gap between those two is
 * where an untested default hides. */
const BOUNDARY_UNTESTABLE = new Set<string>()

const SEAM_RE = /\?\?\s*(default[A-Z]\w*)/g

function* walk(dir: string, wantTests: boolean): Generator<string> {
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return }
  for (const ent of entries) {
    if (ent === 'node_modules' || ent === '.git' || ent === 'dist' || ent === 'target') continue
    const p = join(dir, ent)
    if (statSync(p).isDirectory()) { yield* walk(p, wantTests); continue }
    if (!p.endsWith('.ts') || p.endsWith('.d.ts')) continue
    if (p.endsWith('.test.ts') === wantTests) yield p
  }
}

function findSeams(): Map<string, string[]> {
  const found = new Map<string, string[]>()
  for (const file of walk(join(REPO_ROOT, 'src'), false)) {
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(SEAM_RE)) {
      const name = m[1]!
      const where = relative(REPO_ROOT, file)
      const list = found.get(name) ?? []
      if (!list.includes(where)) list.push(where)
      found.set(name, list)
    }
  }
  return found
}

it('every injectable default is classified as a process boundary or as pure', () => {
  const unclassified: string[] = []
  for (const [name, files] of findSeams()) {
    if (name in BOUNDARY || name in PURE) continue
    unclassified.push(`${name}  (${files.join(', ')})`)
  }
  expect(
    unclassified,
    unclassified.length === 0
      ? ''
      : `New \`?? ${'default'}X\` seam(s) with no classification:\n  ${unclassified.join('\n  ')}\n\n`
        + `Add each to BOUNDARY (it spawns / fetches / imports / touches the host — and then `
        + `write a test that drives the real default) or to PURE (its default is a value or a `
        + `pure computation) in this file, with a one-line reason. This exists because two `
        + `shipped bugs lived in defaults that every test injected past.`,
  ).toEqual([])
})

it('every testable boundary default is named by at least one test file', () => {
  // Exclude this file. It lists every boundary name in BOUNDARY above, so
  // counting itself would make `includes(name)` trivially true and this whole
  // check vacuous — it passed that way on the first run until the scan was
  // inspected rather than trusted.
  const testText = [...walk(join(REPO_ROOT, 'src'), true)]
    .filter(f => f !== SELF)
    .map(f => readFileSync(f, 'utf8'))
    .join('\n')
  const untested = Object.keys(BOUNDARY)
    .filter(name => !BOUNDARY_UNTESTABLE.has(name))
    .filter(name => !testText.includes(name))
  expect(
    untested,
    untested.length === 0
      ? ''
      : `Process-boundary default(s) that no test even mentions:\n  ${untested.join('\n  ')}\n\n`
        + `Production runs only this path. Write a test that calls the real default — or, if a `
        + `hermetic test is genuinely impossible (needs the network or a third-party binary), `
        + `move it to BOUNDARY_UNTESTABLE and make its runtime failure legible instead.`,
  ).toEqual([])
})

it('the seam scan actually finds seams (guards against a silently empty scan)', () => {
  // A path regression that made findSeams() return nothing would make both
  // checks above pass vacuously — the same class of failure they exist to
  // prevent.
  expect(findSeams().size).toBeGreaterThan(5)
})
