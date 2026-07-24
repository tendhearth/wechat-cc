#!/usr/bin/env bun
/**
 * scripts/smoke-compiled-sidecar.ts — CI guardrail #2 (spec
 * 2026-07-23-daemon-owns-llm-memory-ops, Task 5).
 *
 * Guardrail #1 (Task 3, src/lib/cli-llm-eval.ts + cli.ts's `isCompiledBundle()`
 * branches) makes the compiled `wechat-cc-cli` sidecar delegate LLM memory
 * ops to the running daemon instead of inline-spawning
 * `@anthropic-ai/claude-agent-sdk`'s `query()` — because in a `bun build
 * --compile`d binary, the SDK's `findClaudePath()` walks the bunfs virtual
 * filesystem looking for a `claude` CLI that was never bundled there and
 * crashes ("Claude Code process exited …"). That guardrail is unit-tested
 * against the *source* — it has never been proven against a real *compiled*
 * artifact, which is exactly the environment the regression happens in.
 *
 * This script closes that gap: it actually runs `bun build --compile` on
 * cli.ts (mirroring apps/desktop/scripts/build-sidecar.ts, minus the
 * cross-target/codesign machinery — default host target is fine here),
 * then runs `<sidecar> memory synthesize --json` with a fresh, empty
 * WECHAT_STATE_DIR (no internal-api-info.json, i.e. no daemon running) and
 * asserts the process exits cleanly with the structured
 * `{ok:false, error:'daemon_required'}` envelope — never a bunfs crash, a
 * non-JSON stdout, or a "Claude Code process exited" message.
 *
 * Run: bun scripts/smoke-compiled-sidecar.ts
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const cliEntry = join(root, 'cli.ts')

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`)
  process.exit(1)
}

async function main() {
  const buildDir = mkdtempSync(join(tmpdir(), 'wechat-cc-sidecar-build-'))
  const stateDir = mkdtempSync(join(tmpdir(), 'wechat-cc-sidecar-state-'))
  const outfile = join(buildDir, process.platform === 'win32' ? 'wechat-cc-cli-smoke.exe' : 'wechat-cc-cli-smoke')

  try {
    console.log(`compiling sidecar: bun build --compile ${cliEntry} --outfile ${outfile}`)
    const build = Bun.spawn({
      cmd: [process.execPath, 'build', '--compile', cliEntry, '--outfile', outfile],
      cwd: root,
      stdout: 'inherit',
      stderr: 'inherit',
    })
    const buildCode = await build.exited
    if (buildCode !== 0) fail(`bun build --compile exited ${buildCode}`)
    if (!existsSync(outfile)) fail(`compiled binary missing at ${outfile} after a 0-exit build`)

    console.log('running compiled sidecar: <sidecar> memory synthesize --json (fresh, empty STATE_DIR — no daemon)')
    const proc = Bun.spawn({
      cmd: [outfile, 'memory', 'synthesize', '--json'],
      cwd: root,
      // Fresh, empty state dir: no internal-api-info.json → readCliApiInfo()
      // returns null → delegateMemoryOp short-circuits to
      // {ok:false, error:'daemon_required'} without ever touching the
      // network or spawning claude/codex.
      env: { ...process.env, WECHAT_STATE_DIR: stateDir },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])

    const combined = `${stdout}\n${stderr}`

    // The exact regression this smoke test guards against: the compiled
    // sidecar inline-spawning the Claude Agent SDK, which crashes under
    // bunfs's findClaudePath trap instead of delegating cleanly.
    if (/Claude Code process exited/i.test(combined)) {
      fail(`sidecar inline-spawned claude instead of delegating to the daemon (found "Claude Code process exited" in output)\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`)
    }
    if (/\$bunfs/i.test(combined) || /findClaudePath/i.test(combined)) {
      fail(`sidecar hit the bunfs findClaudePath trap\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`)
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(stdout.trim())
    } catch {
      fail(`stdout is not valid JSON (exit ${exitCode})\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`)
    }

    const result = parsed as { ok?: boolean; error?: string }
    if (result.ok !== false || result.error !== 'daemon_required') {
      fail(`expected {ok:false, error:'daemon_required'}, got ${JSON.stringify(parsed)} (exit ${exitCode})\n--- stderr ---\n${stderr}`)
    }
    if (exitCode !== 0) {
      fail(`process exited ${exitCode}; the --json envelope path should exit 0 even on ok:false\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`)
    }

    console.log('PASS: compiled sidecar cleanly delegates `memory synthesize` to the daemon with no daemon running — {ok:false, error:"daemon_required"}, no bunfs crash.')
  } finally {
    rmSync(buildDir, { recursive: true, force: true })
    rmSync(stateDir, { recursive: true, force: true })
  }
}

main().catch((err) => {
  fail(err instanceof Error ? (err.stack ?? err.message) : String(err))
})
