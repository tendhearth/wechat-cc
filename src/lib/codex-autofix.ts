/**
 * codex-autofix — align wechat-cc's bundled codex SDK with the user's
 * locally-installed codex CLI version on boot.
 *
 * Why this exists: the codex SDK ↔ CLI protocol is version-locked
 * (see find-codex-binary.ts). When the user upgrades their global
 * codex CLI ahead of wechat-cc's bundled version, the bundle goes
 * stale relative to user expectation ("I upgraded codex, why is
 * wechat-cc still on 0.128?"). Instead of forcing the user to wait
 * for a wechat-cc release or hand-run npm commands, we detect the
 * mismatch at boot and `bun add` the matching SDK + CLI binary into
 * our own node_modules.
 *
 * Empirical safety: codex SDK public API (Codex, Thread, RunResult,
 * etc.) is stable across patch versions — diffed 0.128 vs 0.133 and
 * exports were identical, only internal wire-protocol changed. So a
 * drop-in npm upgrade preserves source-level compatibility for the
 * consumer (us).
 *
 * Restart policy: this module does NOT restart the daemon. After a
 * successful fix the in-memory SDK is still the pre-fix version
 * (Node already required() it before we ran). The caller logs a
 * "restart required" hint; a future service-mode hook can promote
 * that to process.exit(0) so launchd/systemd KeepAlive picks it up.
 *
 * Opt-out: set WECHAT_CC_DISABLE_CODEX_AUTOFIX=1 in the daemon's env
 * to skip the fix entirely (manual or hostile-network environments).
 */

import { spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'

export interface CodexAutofixDeps {
  /** Directory whose `node_modules` is modified — typically wechat-cc's
   *  install root (where package.json lives). null when we can't find
   *  one (compiled-binary mode), which causes attemptCodexAutofix to
   *  return `unsafe` without spawning anything. */
  installDir: string | null
  /** Currently-bundled SDK version, read from
   *  `node_modules/@openai/codex/package.json` at module load. */
  bundledSdkVersion: string
  /** Resolve the user's local (PATH) codex binary and its `--version`
   *  output. MUST skip the bundled probe — that would loop back to
   *  ourselves. */
  detectUserCodex: () => { path: string | null; version: string | null }
  /** Override the bun-spawn for tests. Returns {ok, stderr}. */
  spawnBun?: (args: ReadonlyArray<string>, cwd: string) => Promise<{ ok: boolean; stderr: string }>
  /** Override the writability check for tests. */
  isWritable?: (path: string) => boolean
  /** True when WECHAT_CC_DISABLE_CODEX_AUTOFIX=1 (or any non-empty value). */
  envDisabled?: boolean
  /** Caller's logger. Called with single-line messages tagged at the
   *  call site. */
  log: (line: string) => void
}

export type CodexAutofixOutcome =
  | { status: 'disabled' }
  | { status: 'no_user_codex' }
  | { status: 'matched'; version: string }
  | { status: 'unsafe'; reason: string }
  | { status: 'fixed'; from: string; to: string }
  | { status: 'failed'; from: string; to: string; reason: string }

export async function attemptCodexAutofix(
  deps: CodexAutofixDeps,
): Promise<CodexAutofixOutcome> {
  if (deps.envDisabled) {
    return { status: 'disabled' }
  }

  const user = deps.detectUserCodex()
  if (!user.path || !user.version) {
    return { status: 'no_user_codex' }
  }

  if (user.version === deps.bundledSdkVersion) {
    return { status: 'matched', version: user.version }
  }

  // Pre-flight: install dir must be writable + bun available.
  if (!deps.installDir) {
    return { status: 'unsafe', reason: 'no install dir resolved (compiled bundle?)' }
  }
  const isWritable = deps.isWritable ?? defaultIsWritable
  if (!isWritable(deps.installDir)) {
    return { status: 'unsafe', reason: `${deps.installDir} not writable` }
  }

  deps.log(
    `local codex v${user.version} ≠ bundled SDK v${deps.bundledSdkVersion} — ` +
    `running \`bun add @openai/codex-sdk@${user.version} @openai/codex@${user.version}\` in ${deps.installDir}`,
  )

  const spawnBun = deps.spawnBun ?? defaultSpawnBun
  const result = await spawnBun(
    ['add', `@openai/codex-sdk@${user.version}`, `@openai/codex@${user.version}`],
    deps.installDir,
  )

  if (!result.ok) {
    return {
      status: 'failed',
      from: deps.bundledSdkVersion,
      to: user.version,
      reason: result.stderr.trim() || '(no stderr)',
    }
  }

  return { status: 'fixed', from: deps.bundledSdkVersion, to: user.version }
}

function defaultIsWritable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK)
    return true
  } catch {
    return false
  }
}

function defaultSpawnBun(
  args: ReadonlyArray<string>,
  cwd: string,
): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn('bun', [...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Inherit PATH so spawning `bun` resolves the user's bun install.
      env: process.env,
    })
    let stderr = ''
    proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    proc.stdout?.on('data', () => { /* drain to prevent backpressure */ })
    proc.on('error', (err: NodeJS.ErrnoException) => {
      const detail = err.code === 'ENOENT'
        ? 'bun not found on PATH'
        : `spawn error: ${err.message}`
      resolve({ ok: false, stderr: detail })
    })
    proc.on('exit', (code: number | null) => {
      resolve({ ok: code === 0, stderr })
    })
  })
}
