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
 *
 * 签名(2026-09-28,Developer ID 证书到手后加的):本机钥匙串里有
 * `Developer ID Application:` 身份时,换 inode 顺手用它重签 —— 先签 `<sidecar>.new`
 * (hardened runtime + entitlements.plist,签完再探一次 `--version`:bun 编译的
 * JIT 二进制缺 entitlement 会被内核直接 SIGKILL,必须在换活之前发现),rename
 * 之后再给整个 .app 重封一次(不 `--deep`,跟 CI 里 tauri 的做法一样)。为什么要
 * 重封 .app:TCC 把授权记在责任进程(主二进制)的「指定要求」上,ad-hoc 签名的
 * 指定要求是一串 cdhash、每次重建都变,Developer ID 的是「identifier + team」,
 * 重建 / 换 sidecar 都不变 —— 这才是权限不再间歇掉的根因修法。没身份 / 没
 * entitlements 文件 ⇒ `plan.signing` 为 null,一切照旧(build-sidecar 的 ad-hoc)。
 */
import { markPlannedRestart } from '../lib/restart-markers'
import { spawnSync as nodeSpawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { readApiInfo } from '../lib/api-info'
import { dirHasPlugins, readPluginsSourcePointer, writePluginsSourcePointer } from '../lib/plugins-source'

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
  /** null ⇒ 不重签(照旧 ad-hoc)。见文件头「签名」。 */
  signing: SelfDeploySigning | null
  /**
   * 内置插件来源登记(2026-09-30)。安装包按设计不带插件(1747de09),打包版 daemon
   * 只能靠状态目录里的来源指针找到主人的插件;部署时顺手把源码 checkout 里真有插件
   * 的目录登记上去。undefined/null ⇒ 不做这一步(老调用方 / 测试手搓的 plan)。
   */
  pluginsSource?: { stateDir: string; candidates: string[] } | null
  /**
   * `--allow-missing-plugins`:插件门红了也照样放行(记 detail + log),给本来就
   * 没有插件的机器用 —— 不必为了部署去永久 `plugin disable`。
   */
  allowMissingPlugins?: boolean
}

export interface SelfDeploySigning {
  /** 钥匙串里的完整身份名,如 `Developer ID Application: Nate Gu & Co LLC (9Y6JAPDP7A)` —— 只用来显示。 */
  identity: string
  /** 证书 SHA-1,`codesign --sign` 用它而不是名字:续期窗口里新旧两张同名同时有效,按名字签会被 ambiguous 拒掉。 */
  identityHash: string
  /** apps/desktop/src-tauri/entitlements.plist —— 与 CI 里 tauri 给 sidecar / .app 用的同一份。 */
  entitlementsPath: string
  /** .app 包根(`<MacOS>` 往上两级),rename 之后整包重封的对象。 */
  appPath: string
}

/** build-sidecar.ts 给 sidecar 打的 identifier —— 重签时保持一致,TCC / 日志里认的是它。 */
const SIDECAR_CODE_IDENTIFIER = 'com.tendhearth.wechat-cc.cli'

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
  /** 调用方用 `detectDeveloperIdIdentity` 探出来的身份;缺省 / null ⇒ 不签。 */
  signingIdentity?: DeveloperIdIdentity | null
  /** entitlements.plist 的路径(调用方已确认存在);缺省 / null ⇒ 不签。 */
  entitlementsPath?: string | null
  /** 可登记为插件来源的目录(源码 checkout 的 plugins/、主 checkout 的 plugins/),按优先级。 */
  pluginSourceCandidates?: string[]
  /** `--allow-missing-plugins`. */
  allowMissingPlugins?: boolean
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
    // --app accepts either the .app bundle root (e.g.
    // /Applications/wechat-cc.app) or an already-fully-qualified
    // .../Contents/MacOS path — don't double-nest the latter.
    macosDir = isMacosDir(input.app) ? stripTrailingSlash(input.app) : posixJoin(input.app, 'Contents', 'MacOS')
  } else if (input.plistXml) {
    const parsed = parseLaunchAgentPlist(input.plistXml)
    const mainBinary = parsed?.programArguments[0]
    if (mainBinary) {
      const dir = posixDirname(mainBinary)
      // Guard against a dev-mode plist (`[bunPath, <repoRoot>/cli.ts, run,
      // ...]`, e.g. before `wechat-cc service install --binary` ever ran).
      // Its ProgramArguments[0] is `bun` on PATH (commonly
      // /opt/homebrew/bin/bun) — dirname of THAT is not an app bundle's
      // MacOS/ dir at all. Silently "succeeding" here would either ENOENT
      // on backup, or worse, overwrite an unrelated binary next to bun,
      // kickstart a source-mode daemon that was never touched, have it
      // pass health trivially, and report exit 0 having deployed nothing.
      // Real app-bundle plists always look like
      // `.../wechat-cc.app/Contents/MacOS/<main-binary>` with argv[1] being
      // a CLI flag (e.g. `--daemon`), never a `.ts` source file.
      const secondArg = parsed!.programArguments[1]
      if (!isMacosDir(dir) || (secondArg !== undefined && secondArg.endsWith('.ts'))) {
        throw new Error('launchagent_not_app_bundle')
      }
      macosDir = dir
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
    signing: input.signingIdentity && input.entitlementsPath
      ? { identity: input.signingIdentity.name, identityHash: input.signingIdentity.hash, entitlementsPath: input.entitlementsPath, appPath: posixDirname(posixDirname(macosDir)) }
      : null,
    pluginsSource: { stateDir: input.stateDir, candidates: input.pluginSourceCandidates ?? [] },
    allowMissingPlugins: input.allowMissingPlugins ?? false,
  }
}

export interface DeveloperIdIdentity {
  name: string
  /** 40 位 SHA-1,`security find-identity` 每行引号前那串。 */
  hash: string
}

/**
 * 从 `security find-identity -v -p codesigning`(`-v` ⇒ 只列有效的,过期的根本
 * 不出现)里挑第一张 `Developer ID Application:`,连 SHA-1 一起。只认 Developer
 * ID(Apple Development 那种签出来 TCC 照样按 cdhash 记,白签);没有 / security
 * 失败 ⇒ null,调用方就按不签处理。
 */
export function detectDeveloperIdIdentity(spawnSync: SelfDeployDeps['spawnSync']): DeveloperIdIdentity | null {
  const r = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], { timeoutMs: 10_000, windowsHide: true })
  if (r.status !== 0) return null
  const m = /\)\s+([0-9A-Fa-f]{40})\s+"(Developer ID Application: [^"]+)"/.exec(r.stdout)
  return m ? { hash: m[1]!, name: m[2]! } : null
}

/**
 * cli(`self deploy`)与自改流水线共用的那一层:探身份 + 找 entitlements.plist,
 * 结果原样喂给 `planSelfDeploy`。`disabled`(`--no-sign`)⇒ 连 security 都不问。
 *
 * entitlements.plist 找两处,先 repoRoot 再 `--binary` 旁边:打包版的 CLI
 * (`wechat-cc self deploy`,手册里的标准回路)把 repoRoot 算成 .app 的 MacOS/
 * 目录,那里没有这个文件 —— 2026-09-28 从 dev 首次部署时一步签名都没跑。而
 * `--binary` 指的是 `<repo>/apps/desktop/src-tauri/binaries/wechat-cc-cli-…`,
 * entitlements.plist 就在 binaries/ 的上一级。两处都没有 ⇒ null,plan 判成不签。
 */
export function resolveSigningInputs(input: {
  repoRoot: string
  disabled: boolean
  /** `--binary`(或计划算出的 newBinaryPath);缺省 ⇒ 只看 repoRoot。 */
  binaryPath?: string | null
  spawnSync: SelfDeployDeps['spawnSync']
  exists: (p: string) => boolean
}): { signingIdentity: DeveloperIdIdentity | null; entitlementsPath: string | null } {
  if (input.disabled) return { signingIdentity: null, entitlementsPath: null }
  const candidates = [posixJoin(input.repoRoot, 'apps', 'desktop', 'src-tauri', 'entitlements.plist')]
  if (input.binaryPath) candidates.push(posixJoin(posixDirname(posixDirname(input.binaryPath)), 'entitlements.plist'))
  return {
    signingIdentity: detectDeveloperIdIdentity(input.spawnSync),
    entitlementsPath: candidates.find((p) => input.exists(p)) ?? null,
  }
}

/**
 * Where the owner's plugins can be registered from (source-mode deploy only):
 * this checkout's `plugins/`, then the MAIN checkout's — the plugins are
 * gitignored per-machine symlinks that exist only there, while deploys usually
 * run from a worktree whose `plugins/` holds just the README. The main checkout
 * is the parent of `git rev-parse --git-common-dir`.
 */
export function pluginSourceCandidates(repoRoot: string, spawnSync: SelfDeployDeps['spawnSync']): string[] {
  const out = [posixJoin(repoRoot, 'plugins')]
  const r = spawnSync('git', ['-C', repoRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { timeoutMs: 5000, windowsHide: true })
  const common = r.status === 0 ? r.stdout.trim() : ''
  if (common) {
    const main = posixJoin(posixDirname(common), 'plugins')
    if (!out.includes(main)) out.push(main)
  }
  return out
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
function stripTrailingSlash(p: string): string {
  return p.replace(/\/+$/, '')
}
/** True when `dir`'s basename is exactly `MacOS` (an app bundle's Contents/MacOS/). */
function isMacosDir(dir: string): boolean {
  const parts = stripTrailingSlash(dir).split('/').filter(Boolean)
  return parts[parts.length - 1] === 'MacOS'
}

// ── execute ──────────────────────────────────────────────────────────

export interface SelfDeployDeps {
  spawnSync: (cmd: string, args: string[], opts?: { timeoutMs?: number; windowsHide?: boolean }) => { status: number | null; stdout: string; stderr: string }
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
  /** kickstart 之前写 planned-restart 纸条(lib/restart-markers)。缺省 ⇒ 不写(测试)。 */
  markPlannedRestart?: (stateDir: string, reason: string) => void
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
  const preflight = deps.spawnSync(plan.newBinaryPath, ['--version'], { timeoutMs: 5000, windowsHide: true })
  if (preflight.status !== 0) {
    steps.push({ name: 'preflight', ok: false, detail: `--version exited ${preflight.status ?? 'null'}: ${(preflight.stderr || preflight.stdout).trim()}` })
    return { ok: false, exitCode: 1, steps }
  }
  const version = (preflight.stdout || preflight.stderr).trim()
  steps.push({ name: 'preflight', ok: true, detail: version })

  // 2. stage — copy the new binary to <sidecar>.new + chmod, BEFORE the
  // backup step touches anything.
  //
  // WHY before backup (2026-09-18 review, C1): the rollback recipe is
  // `self deploy --binary <sidecar>.prev`. With backup running first, that
  // command copied the CURRENT (broken) sidecar over `.prev` — destroying
  // the very binary it was about to install — and then "swapped" the
  // now-broken `.prev` back onto the sidecar. Staging first means the good
  // bytes are already on a fresh inode by the time anything else moves.
  try {
    stageBinary(deps, plan.newBinaryPath, plan.tmpPath)
  } catch (err) {
    try { deps.fs.unlink(plan.tmpPath) } catch { /* best-effort tmp cleanup */ }
    steps.push({ name: 'stage', ok: false, detail: errMsg(err) })
    return { ok: false, exitCode: 1, steps, version }
  }
  steps.push({ name: 'stage', ok: true })

  // 2b. sign — the staged copy gets the Developer ID + hardened runtime +
  // entitlements, then is probed once more: a JIT binary the kernel refuses
  // dies right here (`Killed: 9`), on the still-inert tmp file, with nothing
  // live touched and no backup taken. See the file header.
  //
  // Deploying FROM `.prev` (the rollback recipe, also what the self-change
  // pipeline's rollback does) skips this: that binary already ran live with
  // whatever signature it carries. Re-signing it would only add ways for a
  // rollback to fail (first-use keychain prompt timing out unattended,
  // errSecInternalComponent outside a GUI session, an entitlements.plist the
  // change being rolled back had edited) while the broken binary stays up.
  const deployingFromBackup = samePath(plan.newBinaryPath, plan.prevPath)
  if (plan.signing) {
    const signed = deployingFromBackup
      ? { name: 'sign', ok: true, detail: 'skipped: deploying from the backup itself' }
      : signSidecar(plan, deps)
    if (!signed.ok) {
      // A codesign killed mid-write can leave `<tmp>.cstemp` behind; every
      // later .app seal would then trip over that unsigned file in MacOS/.
      try { deps.fs.unlink(plan.tmpPath) } catch { /* best-effort tmp cleanup */ }
      try { deps.fs.unlink(`${plan.tmpPath}.cstemp`) } catch { /* best-effort */ }
      steps.push(signed)
      return { ok: false, exitCode: 1, steps, version }
    }
    steps.push(signed)
  }

  // 3. backup — <sidecar> → <sidecar>.prev, overwriting whatever backup was
  // already there. Exactly one generation of rollback is kept on purpose.
  //
  // Two cases deliberately DON'T overwrite `.prev` (both keep the existing
  // backup, both count as a successful step — refusing to destroy a good
  // backup is the desired outcome, not a failure):
  //   a) we're deploying FROM `.prev` (the rollback recipe);
  //   b) the sidecar currently on disk fails `--version` (crash-looping /
  //      SIGKILLed build) — backing THAT up would overwrite the last known
  //      good binary with a broken one.
  // `previousVersion` (from that same probe) is what the rollback health
  // gate expects to see, so a successful rollback doesn't print a spurious
  // version mismatch against the NEW binary's version string.
  const currentProbe = deps.spawnSync(plan.sidecarPath, ['--version'], { timeoutMs: 5000, windowsHide: true })
  const currentOk = currentProbe.status === 0
  const previousVersion = currentOk ? (currentProbe.stdout || currentProbe.stderr).trim() : ''
  if (deployingFromBackup) {
    steps.push({ name: 'backup', ok: true, detail: 'skipped: deploying from the backup itself' })
  } else if (!currentOk) {
    steps.push({ name: 'backup', ok: true, detail: 'kept previous backup: current sidecar is broken' })
    deps.log('kept previous backup: current sidecar is broken')
  } else {
    try {
      deps.fs.copyFile(plan.sidecarPath, plan.prevPath)
      steps.push({ name: 'backup', ok: true })
    } catch (err) {
      try { deps.fs.unlink(plan.tmpPath) } catch { /* best-effort tmp cleanup */ }
      steps.push({ name: 'backup', ok: false, detail: errMsg(err) })
      return { ok: false, exitCode: 1, steps, version }
    }
  }

  // 4. swap — rename the already-staged copy over the sidecar. See the file
  // header for why this is copy-to-fresh-path + rename rather than an
  // in-place overwrite.
  try {
    deps.fs.rename(plan.tmpPath, plan.sidecarPath)
    steps.push({ name: 'swap', ok: true })
  } catch (err) {
    try { deps.fs.unlink(plan.tmpPath) } catch { /* best-effort tmp cleanup */ }
    steps.push({ name: 'swap', ok: false, detail: errMsg(err) })
    return { ok: false, exitCode: 1, steps, version }
  }

  // 4b. seal — re-sign the whole .app now that the new sidecar sits inside
  // it. A failed seal happens BEFORE any kickstart: the old daemon is still
  // running, untouched. So this is not a rollback but an aborted deploy —
  // put the `.prev` bytes back (same copy+rename), re-seal, never restart.
  // `plan.rollback` doesn't apply here (it governs the health gate, i.e.
  // after a restart); honouring it would leave an unvalidated sidecar on
  // disk for the next respawn to pick up.
  if (plan.signing) {
    const seal = sealApp(plan.signing, deps)
    steps.push(seal)
    if (!seal.ok) {
      let restored = false
      try {
        swapBinary(deps, plan.prevPath, plan.tmpPath, plan.sidecarPath)
        steps.push({ name: 'restore_swap', ok: true })
        restored = true
      } catch (err) {
        try { deps.fs.unlink(plan.tmpPath) } catch { /* best-effort tmp cleanup */ }
        steps.push({ name: 'restore_swap', ok: false, detail: errMsg(err) })
      }
      steps.push({ ...sealApp(plan.signing, deps), name: 'restore_seal' })
      return { ok: false, exitCode: 1, steps, version, rolledBack: restored }
    }
  }

  // 4c. plugins source — before the restart so the new daemon boots with it.
  // Never fatal: the plugins gate after health is what judges the outcome.
  if (plan.pluginsSource) steps.push(ensurePluginsSource(plan.pluginsSource))

  // 5 + 6. restart + health gate. Everything past this point runs with the
  // NEW binary already on disk, so every failure from here rolls back
  // (unless the caller opted out).
  const kickstartAt = deps.now()
  const restart = kickstart(deps, plan, 'self-deploy')
  steps.push(restart)
  let health: SelfDeployStep | null = null
  let pluginsStep: SelfDeployStep | null = null
  if (restart.ok) {
    deps.log(`waiting for health check (up to ${plan.healthTimeoutMs}ms)...`)
    const gate = await waitForHealth(plan, deps, kickstartAt, plan.healthTimeoutMs, version)
    health = gate.step
    steps.push(health)
    // 6b. plugins gate — only when the daemon reports the snapshot (old
    // daemons, i.e. most rollback targets, don't have the field).
    if (health.ok && gate.plugins !== undefined) {
      pluginsStep = judgePlugins(gate.plugins)
      if (!pluginsStep.ok && plan.allowMissingPlugins) {
        deps.log(`--allow-missing-plugins: passing anyway — ${pluginsStep.detail}`)
        pluginsStep = { name: 'plugins', ok: true, detail: `ALLOWED (--allow-missing-plugins): ${pluginsStep.detail}` }
      }
      steps.push(pluginsStep)
    }
  }

  if (restart.ok && health?.ok && (pluginsStep === null || pluginsStep.ok)) {
    return { ok: true, exitCode: 0, steps, version }
  }

  const diagnostics = collectDiagnostics(deps, plan)

  if (!plan.rollback) {
    return { ok: false, exitCode: 1, steps, version, rolledBack: false, diagnostics }
  }

  deps.log('rolling back to previous binary...')
  // The rollback health gate expects the OLD version (what the sidecar
  // reported before we replaced it), not the new one — otherwise a
  // perfectly successful rollback prints "version mismatch" (#7).
  // Empty string ⇒ no expectation at all (we never got a usable probe).
  const rollbackOutcome = await performRollback(plan, deps, previousVersion)
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

// chmod BEFORE rename, deliberately: rename() is the only step that makes
// the new binary live. If chmod fails (permissions, disk full elsewhere,
// whatever), it fails on the still-inert tmp file — the sidecar the daemon
// actually runs is untouched, so the caller can report a clean `swap`
// failure with nothing live to roll back. Chmod-after-rename would instead
// leave an unvalidated (wrong-permission) binary already serving as the
// sidecar with no restart/health/rollback having run against it.
function stageBinary(deps: SelfDeployDeps, source: string, tmpPath: string): void {
  deps.fs.copyFile(source, tmpPath)
  deps.fs.chmod(tmpPath, 0o755)
}

function swapBinary(deps: SelfDeployDeps, source: string, tmpPath: string, target: string): void {
  stageBinary(deps, source, tmpPath)
  deps.fs.rename(tmpPath, target)
}

/** Same file on disk? Pure string compare after `resolve()` — enough to
 *  recognise `--binary <sidecar>.prev` (the rollback recipe) without
 *  stat-ing anything. */
function samePath(a: string, b: string): boolean {
  return resolve(a) === resolve(b)
}

const CODESIGN_TIMEOUT_MS = 60_000

/** codesign the staged sidecar, then prove it still runs (`--version`). */
function signSidecar(plan: SelfDeployPlan, deps: SelfDeployDeps): SelfDeployStep {
  const { identity, identityHash, entitlementsPath } = plan.signing!
  const r = deps.spawnSync('codesign', [
    '--force', '--sign', identityHash, '--options', 'runtime',
    '--entitlements', entitlementsPath, '--identifier', SIDECAR_CODE_IDENTIFIER, plan.tmpPath,
  ], { timeoutMs: CODESIGN_TIMEOUT_MS, windowsHide: true })
  if (r.status !== 0) return { name: 'sign', ok: false, detail: `codesign exited ${r.status ?? 'null'}: ${(r.stderr || r.stdout).trim()}` }
  const probe = deps.spawnSync(plan.tmpPath, ['--version'], { timeoutMs: 5000, windowsHide: true })
  if (probe.status !== 0) return { name: 'sign', ok: false, detail: `signed binary fails --version (exit ${probe.status ?? 'null'}): ${(probe.stderr || probe.stdout).trim()}` }
  return { name: 'sign', ok: true, detail: identity }
}

/** Re-sign the .app bundle (main binary + resource seal). No `--deep`: nested binaries carry their own signatures. */
function sealApp(signing: SelfDeploySigning, deps: SelfDeployDeps): SelfDeployStep {
  const r = deps.spawnSync('codesign', [
    '--force', '--sign', signing.identityHash, '--options', 'runtime',
    '--entitlements', signing.entitlementsPath, signing.appPath,
  ], { timeoutMs: CODESIGN_TIMEOUT_MS, windowsHide: true })
  if (r.status !== 0) return { name: 'seal', ok: false, detail: `codesign exited ${r.status ?? 'null'}: ${(r.stderr || r.stdout).trim()}` }
  return { name: 'seal', ok: true }
}

function kickstart(deps: SelfDeployDeps, plan: SelfDeployPlan, reason: string): SelfDeployStep {
  // 先留「计划内重启」纸条再 kickstart:部署/回滚是维护者故意的,新 daemon
  // 开机读到它就不在微信里播报(daemon/notify-startup.ts)。状态目录就是
  // internal-api-info.json 所在的目录。用 node 的 dirname 而不是 posixDirname:
  // 后者只认 '/',遇到 win32 的反斜杠路径会退化成 '/',纸条就写错了地方(CI windows 抓到)。
  deps.markPlannedRestart?.(dirname(plan.infoPath), reason)
  const r = deps.spawnSync('launchctl', ['kickstart', '-k', plan.serviceTarget], { windowsHide: true })
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
interface HealthGate {
  step: SelfDeployStep
  /** `GET /v1/health.plugins` once it is an object; undefined when the daemon doesn't report it. */
  plugins?: HealthPlugins
}

/**
 * Wire shape of `GET /v1/health.plugins` (src/daemon/plugins/health.ts
 * `PluginsHealthWire`) — the summary every tier gets. The gate probes with the
 * FILE token (below admin), so it never sees paths or plugin lists.
 */
interface HealthPlugins {
  via: string | null
  count: number
  ready_count: number
  expected_missing: string[]
  pointer_broken: boolean
}

async function waitForHealth(plan: SelfDeployPlan, deps: SelfDeployDeps, sinceMs: number, timeoutMs: number, expectedVersion: string): Promise<HealthGate> {
  const deadline = deps.now() + timeoutMs
  for (;;) {
    const mtime = deps.fs.mtimeMs(plan.infoPath)
    if (mtime !== null && mtime > sinceMs) {
      const token = deps.readFileToken(plan.infoPath)
      if (token) {
        try {
          // Cap each probe at whatever's left of the overall health-gate
          // budget (floor 1s) — otherwise a single hung request can eat the
          // entire timeout window without the poll loop ever getting to
          // retry or to report a clean timeout.
          const remaining = Math.max(1000, deadline - deps.now())
          const res = await deps.fetch(`${token.baseUrl}/v1/health`, {
            headers: { authorization: `Bearer ${token.token}` },
            signal: AbortSignal.timeout(remaining),
          })
          if (res.ok) {
            let cliVersion: string | undefined
            let head: string | null | undefined
            let body: { version?: { cli?: string; head?: string | null }; plugins?: HealthPlugins | null } = {}
            try {
              body = (await res.json()) as typeof body
              cliVersion = body.version?.cli; head = body.version?.head
            } catch { /* body optional */ }
            // `plugins: null` = the daemon is up but bootstrap hasn't wired the
            // plugin lane yet — not a verdict; keep polling.
            if (body.plugins === null) {
              if (deps.now() >= deadline) return { step: { name: 'health', ok: false, detail: 'timed out waiting for bootstrap (health.plugins stayed null)' } }
              await deps.sleep(HEALTH_POLL_INTERVAL_MS)
              continue
            }
            // `--version` 打的是一行 `1.7.0 (63edf14c)`,而健康接口分成 cli(纯 semver)
            // 与 head(构建 sha)两格 —— 必须拆开逐格比。2026-09-22 真踩过:版本号带上
            // 构建标识那天,这里整行相等的比较从此永远不成立,每次部署都打一行假的
            // "version mismatch",门却照样绿 —— 正是把人训练成忽略失败行的那种。
            // 按「剥掉结尾的 (sha)」来拆,而不是「取第一个词」—— 有的二进制把版本打成
            // 多个词(`wechat-cc-cli 9.9.8-old`),取第一个词会把它判成不一致。
            const expected = expectedVersion ?? ''
            const wantSha = /\(([^()]+)\)\s*$/.exec(expected)?.[1]
            const wantVersion = expected.replace(/\s*\([^()]+\)\s*$/, '')
            const versionBad = !!cliVersion && !!wantVersion && cliVersion !== wantVersion
            // 源码跑出来的产物 sha 是 'dev',那种情况下不比 —— 比了永远不相等。
            const shaBad = !!wantSha && wantSha !== 'dev' && !!head && head !== wantSha
            const seen = `${cliVersion ?? '?'}${head ? ` (${head})` : ''}`
            const step = { name: 'health', ok: true, detail: versionBad || shaBad ? `version mismatch: preflight=${expectedVersion} health=${seen}` : seen }
            return body.plugins ? { step, plugins: body.plugins } : { step }
          }
        } catch { /* daemon may still be coming up — keep polling */ }
      }
    }
    if (deps.now() >= deadline) return { step: { name: 'health', ok: false, detail: 'timed out waiting for health check' } }
    await deps.sleep(HEALTH_POLL_INTERVAL_MS)
  }
}

/**
 * Register the plugins source pointer: keep a pointer that still resolves to
 * real plugins (explicit operator choice), otherwise take the first candidate
 * that has any. Uses the real fs (state dir, outside the .app).
 */
function ensurePluginsSource(src: { stateDir: string; candidates: string[] }): SelfDeployStep {
  try {
    const current = readPluginsSourcePointer(src.stateDir)
    if (current && dirHasPlugins(current)) return { name: 'plugins_source', ok: true, detail: `kept ${current}` }
    const hit = src.candidates.find(dirHasPlugins)
    if (!hit) return { name: 'plugins_source', ok: true, detail: `none registered: no plugins in ${src.candidates.join(', ') || '(no candidates)'}` }
    writePluginsSourcePointer(src.stateDir, hit)
    return { name: 'plugins_source', ok: true, detail: `registered ${hit}` }
  } catch (err) {
    return { name: 'plugins_source', ok: true, detail: `could not register: ${errMsg(err)}` }
  }
}

/**
 * Red (and roll back) when an expected plugin — registered with the source, or
 * explicitly enabled — was not even discovered, or the registered source holds
 * nothing any more.
 */
function judgePlugins(p: HealthPlugins): SelfDeployStep {
  const from = p.via ? `via ${p.via}` : 'no bundled plugins dir'
  const problems: string[] = []
  if (p.pointer_broken) problems.push('registered plugins source holds no plugins any more')
  if (p.expected_missing.length > 0) problems.push(`expected plugin(s) not loaded: ${p.expected_missing.join(', ')}`)
  if (problems.length > 0) {
    return { name: 'plugins', ok: false, detail: `${problems.join('; ')} — ${from}; fix with \`wechat-cc plugin source <dir>\` (or --allow-missing-plugins)` }
  }
  return { name: 'plugins', ok: true, detail: `${p.ready_count}/${p.count} ready — ${from}` }
}

async function performRollback(plan: SelfDeployPlan, deps: SelfDeployDeps, expectedVersion: string): Promise<{ steps: SelfDeployStep[]; rolledBack: boolean; healthy: boolean }> {
  const steps: SelfDeployStep[] = []
  try {
    swapBinary(deps, plan.prevPath, plan.tmpPath, plan.sidecarPath)
    steps.push({ name: 'rollback_swap', ok: true })
  } catch (err) {
    try { deps.fs.unlink(plan.tmpPath) } catch { /* best-effort tmp cleanup */ }
    steps.push({ name: 'rollback_swap', ok: false, detail: errMsg(err) })
    return { steps, rolledBack: false, healthy: false }
  }
  // `.prev` is whatever was live before (already Developer-ID-signed, or the
  // ad-hoc build from before this feature — both run), so it isn't re-signed;
  // the bundle seal is redone because the sidecar inside it changed again.
  // Recorded, never fatal: the old binary is back either way.
  if (plan.signing) steps.push({ ...sealApp(plan.signing, deps), name: 'rollback_seal' })

  const kickstartAt = deps.now()
  const restart = kickstart(deps, plan, 'self-deploy-rollback')
  steps.push({ ...restart, name: 'rollback_restart' })
  if (!restart.ok) return { steps, rolledBack: true, healthy: false }

  const health = (await waitForHealth(plan, deps, kickstartAt, plan.healthTimeoutMs, expectedVersion)).step
  steps.push({ ...health, name: 'rollback_health' })
  return { steps, rolledBack: true, healthy: health.ok }
}

function collectDiagnostics(deps: SelfDeployDeps, plan: SelfDeployPlan): string {
  const printed = deps.spawnSync('launchctl', ['print', plan.serviceTarget], { windowsHide: true })
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
    // Shared reader (src/lib/api-info.ts) — same one `selftest` uses. The
    // health gate deliberately probes with the FILE token (narrowest
    // credential; the operator token can't reach GET /v1/health at all).
    readFileToken: (infoPath) => {
      const info = readApiInfo(dirname(infoPath))
      return info ? { baseUrl: info.baseUrl, token: info.token } : null
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (line) => console.error(`[self deploy] ${line}`),
    markPlannedRestart: (stateDir, reason) => markPlannedRestart(stateDir, reason),
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
