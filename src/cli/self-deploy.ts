/**
 * self-deploy.ts — `wechat-cc self deploy`: atomic sidecar swap into the
 * .app bundle, daemon restart via launchd, health gate, automatic rollback.
 *
 * spec: docs/superpowers/specs/2026-09-18-self-maintenance-design.md §3
 *
 * WHY copy+rename at the swap step (not an in-place `cp`): on 2026-09-17 a
 * real-machine deploy did `cp <new> <sidecar>` over the running sidecar and
 * the new binary came up permanently SIGKILLed (exit 137 — even `--version`
 * died). macOS keeps a per-inode code-signing validity cache; overwriting
 * file *content* in place reuses the old inode, so the kernel kept
 * re-checking a cache entry that no longer matched the bytes on disk.
 * Writing the new binary to a fresh path and `rename()`-ing it over the
 * target gives the replacement a brand-new inode, so the kernel builds a
 * fresh cache entry instead of reusing a poisoned one. Rollback uses the
 * same copy+rename trick for the same reason.
 */
import { spawnSync as nodeSpawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { readJsonFile } from '../lib/read-json-file'

export interface LaunchAgentInfo {
  programArguments: string[]
  stderrPath: string | null
}

/**
 * Simple regex scan over a launchd plist — same tolerant approach as
 * binary-detect.ts's parseLaunchdProgramArgument, extended to pull every
 * <string> out of the ProgramArguments <array> (not just the first) plus
 * StandardErrorPath. launchd plists are user/installer-generated XML, not
 * canonical output, so this deliberately doesn't require a real XML parser.
 * Missing/malformed input (no ProgramArguments array, or an empty one) ⇒
 * null so callers can fall back to --app.
 */
export function parseLaunchAgentPlist(xml: string): LaunchAgentInfo | null {
  const arrayMatch = /<key>\s*ProgramArguments\s*<\/key>\s*<array>([\s\S]*?)<\/array>/i.exec(xml)
  if (!arrayMatch) return null

  const stringRe = /<string>([\s\S]*?)<\/string>/gi
  const programArguments: string[] = []
  let m: RegExpExecArray | null
  // eslint-disable-next-line no-cond-assign
  while ((m = stringRe.exec(arrayMatch[1]!))) {
    const value = unescapeXml(m[1]!.trim())
    if (value) programArguments.push(value)
  }
  if (programArguments.length === 0) return null

  let stderrPath: string | null = null
  const errMatch = /<key>\s*StandardErrorPath\s*<\/key>\s*<string>([\s\S]*?)<\/string>/i.exec(xml)
  if (errMatch) stderrPath = unescapeXml(errMatch[1]!.trim()) || null

  return { programArguments, stderrPath }
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

// ── plan ─────────────────────────────────────────────────────────────

export interface SelfDeployPlan {
  platform: string
  sidecarPath: string
  newBinaryPath: string
  prevPath: string
  tmpPath: string
  /** `gui/<uid>/com.wechat-cc.daemon` — the launchctl target for kickstart/print. */
  serviceTarget: string
  stderrLogPath: string | null
  infoPath: string
  healthTimeoutMs: number
  rollback: boolean
}

const DEFAULT_HEALTH_TIMEOUT_MS = 60_000
// Fallback stderr log path when the plist has no StandardErrorPath (or no
// plist was found at all and --app was used instead) — matches the path
// every installed LaunchAgent plist has written to since service-manager.ts
// introduced logDir.
const DEFAULT_STDERR_LOG_PARTS = ['.claude', 'channels', 'wechat', 'launchd.err.log'] as const

export interface PlanSelfDeployInput {
  platform: NodeJS.Platform
  arch: string
  homeDir: string
  uid: number
  repoRoot: string
  stateDir: string
  /** Contents of ~/Library/LaunchAgents/com.wechat-cc.daemon.plist, or null when absent. */
  plistXml: string | null
  /** Explicit path to the freshly built sidecar binary. Defaults to the repo's build-sidecar output for process.arch. */
  binary?: string
  /** .app bundle path — overrides the plist-derived target for where the sidecar lives. */
  app?: string
  healthTimeoutMs?: number
  rollback?: boolean
}

/**
 * Pure planner: turns CLI input + the on-disk plist (already read by the
 * caller) into an executable plan. Throws rather than returning an error
 * value — planning failures (unsupported platform, no LaunchAgent found)
 * are precondition violations the caller should surface immediately, not
 * partial results to inspect.
 */
export function planSelfDeploy(input: PlanSelfDeployInput): SelfDeployPlan {
  if (input.platform !== 'darwin') throw new Error('self_deploy_unsupported_platform')

  let macosDir: string | null = null
  let stderrPathFromPlist: string | null = null

  if (input.app) {
    // --app points at the .app bundle itself (e.g. /Applications/wechat-cc.app).
    macosDir = posixJoin(input.app, 'Contents', 'MacOS')
  } else if (input.plistXml) {
    const parsed = parseLaunchAgentPlist(input.plistXml)
    const mainBinary = parsed?.programArguments[0]
    if (mainBinary) {
      macosDir = posixDirname(mainBinary)
      stderrPathFromPlist = parsed!.stderrPath
    }
  }
  if (!macosDir) throw new Error('launchagent_not_found')

  const sidecarPath = posixJoin(macosDir, 'wechat-cc-cli')
  const archSuffix = input.arch === 'arm64' ? 'aarch64' : input.arch === 'x64' ? 'x86_64' : input.arch
  const newBinaryPath = input.binary
    ?? posixJoin(input.repoRoot, 'apps', 'desktop', 'src-tauri', 'binaries', `wechat-cc-cli-${archSuffix}-apple-darwin`)

  return {
    platform: input.platform,
    sidecarPath,
    newBinaryPath,
    prevPath: `${sidecarPath}.prev`,
    tmpPath: `${sidecarPath}.new`,
    serviceTarget: `gui/${input.uid}/com.wechat-cc.daemon`,
    stderrLogPath: stderrPathFromPlist ?? posixJoin(input.homeDir, ...DEFAULT_STDERR_LOG_PARTS),
    infoPath: posixJoin(input.stateDir, 'internal-api-info.json'),
    healthTimeoutMs: input.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS,
    rollback: input.rollback ?? true,
  }
}

// posix.join/dirname equivalents that don't pull in node:path just for two
// string ops — self-deploy only ever targets darwin, and keeping this pure
// (no node:path import) makes the plan function trivially testable with
// plain strings regardless of the host running the test.
function posixJoin(...parts: string[]): string {
  return parts
    .map((p, i) => (i === 0 ? p.replace(/\/+$/, '') : p.replace(/^\/+|\/+$/g, '')))
    .filter((p) => p.length > 0)
    .join('/')
}
function posixDirname(p: string): string {
  const idx = p.lastIndexOf('/')
  return idx <= 0 ? '/' : p.slice(0, idx)
}

// ── execute ──────────────────────────────────────────────────────────

export interface SelfDeployDeps {
  spawnSync: (cmd: string, args: string[], opts?: { timeoutMs?: number }) => { status: number | null; stdout: string; stderr: string }
  fs: {
    exists(p: string): boolean
    copyFile(a: string, b: string): void
    rename(a: string, b: string): void
    chmod(p: string, mode: number): void
    mtimeMs(p: string): number | null
    readTail(p: string, lines: number): string
    unlink(p: string): void
  }
  fetch: typeof globalThis.fetch
  readFileToken: (infoPath: string) => { baseUrl: string; token: string } | null
  now: () => number
  sleep: (ms: number) => Promise<void>
  log: (line: string) => void
}

export interface SelfDeployStep {
  name: string
  ok: boolean
  detail?: string
}

export interface SelfDeployResult {
  ok: boolean
  exitCode: 0 | 1 | 3
  steps: SelfDeployStep[]
  version?: string
  rolledBack?: boolean
  diagnostics?: string
}

const HEALTH_POLL_INTERVAL_MS = 500

export async function executeSelfDeploy(plan: SelfDeployPlan, deps: SelfDeployDeps): Promise<SelfDeployResult> {
  const steps: SelfDeployStep[] = []

  // 1. preflight — new binary exists and `--version` exits 0. Nothing on
  // disk is touched yet, so a preflight failure just returns — no rollback
  // possible or needed.
  if (!deps.fs.exists(plan.newBinaryPath)) {
    steps.push({ name: 'preflight', ok: false, detail: `binary not found: ${plan.newBinaryPath}` })
    return { ok: false, exitCode: 1, steps }
  }
  const preflight = deps.spawnSync(plan.newBinaryPath, ['--version'], { timeoutMs: 5000 })
  if (preflight.status !== 0) {
    steps.push({ name: 'preflight', ok: false, detail: `--version exited ${preflight.status ?? 'null'}: ${(preflight.stderr || preflight.stdout).trim()}` })
    return { ok: false, exitCode: 1, steps }
  }
  const version = (preflight.stdout || preflight.stderr).trim()
  steps.push({ name: 'preflight', ok: true, detail: version })

  // 2. backup — <sidecar> → <sidecar>.prev, overwriting whatever backup was
  // already there. Exactly one generation of rollback is kept on purpose.
  try {
    deps.fs.copyFile(plan.sidecarPath, plan.prevPath)
    steps.push({ name: 'backup', ok: true })
  } catch (err) {
    steps.push({ name: 'backup', ok: false, detail: errMsg(err) })
    return { ok: false, exitCode: 1, steps, version }
  }

  // 3. swap — see file header for why this is copy-to-fresh-path + rename
  // rather than an in-place overwrite.
  try {
    swapBinary(deps, plan.newBinaryPath, plan.tmpPath, plan.sidecarPath)
    steps.push({ name: 'swap', ok: true })
  } catch (err) {
    try { deps.fs.unlink(plan.tmpPath) } catch { /* best-effort tmp cleanup */ }
    steps.push({ name: 'swap', ok: false, detail: errMsg(err) })
    return { ok: false, exitCode: 1, steps, version }
  }

  // 4 + 5. restart + health gate. Everything past this point runs with the
  // NEW binary already on disk, so every failure from here rolls back
  // (unless the caller opted out).
  const kickstartAt = deps.now()
  const restart = kickstart(deps, plan.serviceTarget)
  steps.push(restart)
  let health: SelfDeployStep | null = null
  if (restart.ok) {
    deps.log(`waiting for health check (up to ${plan.healthTimeoutMs}ms)...`)
    health = await waitForHealth(plan, deps, kickstartAt, plan.healthTimeoutMs, version)
    steps.push(health)
  }

  if (restart.ok && health?.ok) {
    return { ok: true, exitCode: 0, steps, version }
  }

  const diagnostics = collectDiagnostics(deps, plan)

  if (!plan.rollback) {
    return { ok: false, exitCode: 1, steps, version, rolledBack: false, diagnostics }
  }

  deps.log('rolling back to previous binary...')
  const rollbackOutcome = await performRollback(plan, deps, version)
  steps.push(...rollbackOutcome.steps)

  return {
    ok: false,
    exitCode: rollbackOutcome.healthy ? 1 : 3,
    steps,
    version,
    rolledBack: rollbackOutcome.rolledBack,
    diagnostics,
  }
}

function swapBinary(deps: SelfDeployDeps, source: string, tmpPath: string, target: string): void {
  deps.fs.copyFile(source, tmpPath)
  deps.fs.rename(tmpPath, target)
  deps.fs.chmod(target, 0o755)
}

function kickstart(deps: SelfDeployDeps, serviceTarget: string): SelfDeployStep {
  const r = deps.spawnSync('launchctl', ['kickstart', '-k', serviceTarget])
  if (r.status !== 0) return { name: 'restart', ok: false, detail: `launchctl kickstart exited ${r.status ?? 'null'}: ${r.stderr.trim()}` }
  return { name: 'restart', ok: true }
}

/**
 * Poll until STATE_DIR/internal-api-info.json's mtime is later than
 * `sinceMs` (proof the new process actually rewrote it — an old process
 * clinging to life via a stale info file would otherwise pass a health
 * check against itself) and GET /v1/health returns 200. A version mismatch
 * between preflight's `--version` and health's `version.cli` is recorded
 * as a detail note but does NOT fail the check — spec §3 treats it as a
 * warning (e.g. the running daemon reports its own build metadata slightly
 * differently than the sidecar's --version string).
 */
async function waitForHealth(plan: SelfDeployPlan, deps: SelfDeployDeps, sinceMs: number, timeoutMs: number, expectedVersion: string): Promise<SelfDeployStep> {
  const deadline = deps.now() + timeoutMs
  for (;;) {
    const mtime = deps.fs.mtimeMs(plan.infoPath)
    if (mtime !== null && mtime > sinceMs) {
      const token = deps.readFileToken(plan.infoPath)
      if (token) {
        try {
          const res = await deps.fetch(`${token.baseUrl}/v1/health`, { headers: { authorization: `Bearer ${token.token}` } })
          if (res.ok) {
            let cliVersion: string | undefined
            try { cliVersion = ((await res.json()) as { version?: { cli?: string } }).version?.cli } catch { /* body optional */ }
            const mismatch = !!cliVersion && !!expectedVersion && cliVersion !== expectedVersion
            return { name: 'health', ok: true, detail: mismatch ? `version mismatch: preflight=${expectedVersion} health=${cliVersion}` : cliVersion }
          }
        } catch { /* daemon may still be coming up — keep polling */ }
      }
    }
    if (deps.now() >= deadline) return { name: 'health', ok: false, detail: 'timed out waiting for health check' }
    await deps.sleep(HEALTH_POLL_INTERVAL_MS)
  }
}

async function performRollback(plan: SelfDeployPlan, deps: SelfDeployDeps, expectedVersion: string): Promise<{ steps: SelfDeployStep[]; rolledBack: boolean; healthy: boolean }> {
  const steps: SelfDeployStep[] = []
  try {
    swapBinary(deps, plan.prevPath, plan.tmpPath, plan.sidecarPath)
    steps.push({ name: 'rollback_swap', ok: true })
  } catch (err) {
    steps.push({ name: 'rollback_swap', ok: false, detail: errMsg(err) })
    return { steps, rolledBack: false, healthy: false }
  }

  const kickstartAt = deps.now()
  const restart = kickstart(deps, plan.serviceTarget)
  steps.push({ ...restart, name: 'rollback_restart' })
  if (!restart.ok) return { steps, rolledBack: true, healthy: false }

  const health = await waitForHealth(plan, deps, kickstartAt, plan.healthTimeoutMs, expectedVersion)
  steps.push({ ...health, name: 'rollback_health' })
  return { steps, rolledBack: true, healthy: health.ok }
}

function collectDiagnostics(deps: SelfDeployDeps, plan: SelfDeployPlan): string {
  const printed = deps.spawnSync('launchctl', ['print', plan.serviceTarget])
  const relevant = (printed.stdout || '')
    .split('\n')
    .filter((l) => /state|runs|last exit/i.test(l))
    .join('\n')
  const stderrTail = plan.stderrLogPath ? deps.fs.readTail(plan.stderrLogPath, 40) : ''
  return [
    `launchctl print ${plan.serviceTarget}:`,
    relevant || '(no matching lines)',
    '',
    `stderr tail (${plan.stderrLogPath ?? 'unknown'}):`,
    stderrTail || '(empty)',
  ].join('\n')
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ── real deps (used by cli.ts) ──────────────────────────────────────

export function defaultSelfDeployDeps(): SelfDeployDeps {
  return {
    spawnSync(cmd, args, opts) {
      const r = nodeSpawnSync(cmd, args, { encoding: 'utf8', timeout: opts?.timeoutMs, windowsHide: true })
      return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
    },
    fs: {
      exists: (p) => existsSync(p),
      copyFile: (a, b) => copyFileSync(a, b),
      rename: (a, b) => renameSync(a, b),
      chmod: (p, mode) => chmodSync(p, mode),
      mtimeMs: (p) => { try { return statSync(p).mtimeMs } catch { return null } },
      readTail: (p, lines) => readTailLines(p, lines),
      unlink: (p) => { try { unlinkSync(p) } catch { /* best-effort */ } },
    },
    fetch,
    readFileToken: (infoPath) => {
      try {
        const info = readJsonFile<{ baseUrl?: string; tokenFilePath?: string }>(infoPath)
        if (!info.baseUrl || !info.tokenFilePath) return null
        return { baseUrl: info.baseUrl, token: readFileSync(info.tokenFilePath, 'utf8').trim() }
      } catch { return null }
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (line) => console.error(`[self deploy] ${line}`),
  }
}

function readTailLines(path: string, lines: number): string {
  try {
    const content = readFileSync(path, 'utf8')
    const all = content.split('\n')
    return all.slice(Math.max(0, all.length - lines)).join('\n')
  } catch {
    return ''
  }
}
