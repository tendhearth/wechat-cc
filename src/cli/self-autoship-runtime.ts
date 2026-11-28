import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { cpus, homedir, loadavg } from 'node:os'
import { join, resolve } from 'node:path'
import z from 'zod'
import { loadAgentConfig } from '../lib/agent-config'
import { autoshipWindowStatus, loadAutoshipConfig, patchAutoshipConfig } from '../lib/autoship-config'
import { machineIdleSeconds } from '../lib/machine-idle'
import { readApiInfo } from '../lib/api-info'
import { log } from '../lib/log'
import { readJsonObject, writeFileAtomic } from '../lib/json-file'
import { defaultCiTriageDeps, runCiTriage, CI_TRIAGE_EXIT } from './ci-triage-run'
import { defaultDeployTaskGate } from './deploy-task-gate'
import { DeploymentLedgerError, deploymentFailures, gitObjectId, matchesFailedTree } from './deployment-failures'
import { makeDaemonClient, type DeployReadiness } from './self-change/daemon-client'
import { makeGit, nodeGitSpawnSync, type Git } from './self-change/git'
import { launchAgentPlistPath } from './self-change/index'
import { defaultWorkdir } from './self-change/policy'
import { tryAutoshipLock, makeStateStore, selfChangeDir } from './self-change/state'
import { hubPath } from './self-change/steps'
import { parseLaunchAgentPlist, planSelfDeploy, type SelfDeployPlan } from './self-deploy'
import { acquireDeploymentLock, DEPLOYMENT_BUSY, deploymentLockPath, deploymentTransactions, type DeploymentLock } from './deployment-transaction'
import { DEFAULT_MAX_LOAD_PER_CPU } from './self-ship'
import { shipFromRepo } from './self-ship-runtime'
import { AutoshipPreparationError, type runAutoshipCommand, type AutoshipRepo, type InstalledVersion } from './self-autoship'

const stateShape = z.object({
  failedShas: z.array(gitObjectId).default([]),
  redShas: z.array(gitObjectId).default([]),
  fail_streak: z.number().int().nonnegative().default(0),
  halted_at: z.number().int().nonnegative().nullable().default(null),
  halt_reason: z.string().nullable().default(null),
  pause_reason: z.string().optional(),
})
const roundShape = z.object({ sha: gitObjectId.nullable(), at: z.string(), exitCode: z.number().int(), message: z.string() })

export function autoshipStore(stateDir: string) {
  const dir = selfChangeDir(stateDir)
  const statePath = join(dir, 'autoship-state.json')
  const roundPath = join(dir, 'autoship.json')
  const skipPath = join(dir, 'autoship-skip.json')
  const save = (file: string, value: unknown) => writeFileAtomic(file, JSON.stringify(value) + '\n', { mode: 0o600 })
  const readRound = (path: string) => existsSync(path) ? roundShape.parse(readJsonObject(path)) : null
  return {
    loadState: () => stateShape.parse(readJsonObject(statePath)),
    saveState: (state: z.infer<typeof stateShape>) => save(statePath, state),
    lastRound: () => readRound(roundPath),
    saveRound: (round: z.infer<typeof roundShape>) => save(roundPath, round),
    lastSkip: () => readRound(skipPath),
    saveSkip: (round: z.infer<typeof roundShape>) => save(skipPath, round),
  }
}

export function parseInstalledVersion(version: string): InstalledVersion {
  const clean = version.trim()
  return { version: clean, sha: clean.match(/\(([a-f0-9]{7,64})\)$/)?.[1] ?? null }
}

function samePath(a: string, b: string): boolean {
  // .native:Windows 上 git 给的是长路径(runneradmin),临时目录是 8.3 短名(RUNNER~1),JS 版 realpath 不展开短名;
  // Windows 路径不分大小写(2026-11-28 合并队列里 Windows 上抓到)。
  const norm = (p: string) => { const r = realpathSync.native(p); return process.platform === 'win32' ? r.toLowerCase() : r }
  try { return norm(a) === norm(b) } catch { return false }
}

export function matchesLaunchAgent(
  daemon: DeployReadiness, expected: { pid: number; bootAt: string; stateDir: string; plistPath: string; program: string; sidecar: string; supervisedByApp: boolean },
  loaded: { pid: number; path: string; program: string }, pathsMatch = samePath,
): boolean {
  return daemon.compiled && daemon.pid === expected.pid && daemon.bootAt === expected.bootAt
    && loaded.pid === (expected.supervisedByApp ? daemon.parentPid : daemon.pid)
    && pathsMatch(daemon.stateDir, expected.stateDir) && pathsMatch(daemon.execPath, expected.sidecar)
    && pathsMatch(loaded.path, expected.plistPath) && pathsMatch(loaded.program, expected.program)
}

export function parseLoadedLaunchAgent(output: string): { pid: number; path: string; program: string } {
  // 只取顶层 job 属性，避免读到子段下的同名字段。
  const field = (name: string) => new RegExp(`^(?:\\t| {1,4})${name} = (.+)$`, 'm').exec(output)?.[1]?.trim() ?? ''
  return { pid: Number(field('pid')), path: field('path'), program: field('program') }
}

const FETCH_TIMEOUT_MS = 60_000
const FINAL_FETCH_TIMEOUT_MS = 25_000
const DEV_REF = 'refs/remotes/origin/dev'

export function refreshAutoshipDev(git: Git, timeoutMs: number): string | null {
  const fetch = git.run(['fetch', 'origin', `+refs/heads/dev:${DEV_REF}`], { timeoutMs })
  if (fetch.code !== 0) return null
  const head = git.run(['rev-parse', '--verify', DEV_REF], { timeoutMs: 5000 })
  const parsed = gitObjectId.safeParse(head.stdout.trim())
  return head.code === 0 && parsed.success ? parsed.data : null
}

export function defaultAutoshipDeps(stateDir: string, sourceRoot: string | null, homeDir = homedir()): Parameters<typeof runAutoshipCommand>[0] {
  const plistPath = launchAgentPlistPath(homeDir)
  const store = autoshipStore(stateDir)
  const transactions = deploymentTransactions(deploymentLockPath(homeDir), stateDir)
  const settings = () => loadAutoshipConfig(stateDir)
  const selfChange = () => loadAgentConfig(stateDir).self_change
  const workdirFor = () => resolve(selfChange()?.workdir ?? defaultWorkdir(homeDir, process.platform))
  const daemon = makeDaemonClient({ readApiInfo: () => readApiInfo(stateDir), fetch })
  const failures = deploymentFailures(homeDir)
  let deployLock: DeploymentLock | undefined

  const repoUrl = () => {
    const configured = selfChange()?.repo_url ?? settings().repo_url
    if (configured !== undefined) return configured.trim() || null
    for (const cwd of [sourceRoot, hubPath({ workdir: workdirFor() })]) {
      if (!cwd || !existsSync(cwd)) continue
      const origin = makeGit(nodeGitSpawnSync, cwd).run(['remote', 'get-url', 'origin'])
      if (origin.code === 0 && origin.stdout.trim()) return origin.stdout.trim()
    }
    return null
  }

  const targetPlan = (plistXml: string) => planSelfDeploy({
    homeDir, stateDir, platform: process.platform, arch: process.arch, uid: process.getuid?.() ?? 501,
    repoRoot: homeDir, plistXml, exists: existsSync,
  })

  async function checkTarget(plan?: SelfDeployPlan): Promise<{ reason: string } | { ready: DeployReadiness }> {
    const expectedPid = Number(process.env.WECHAT_CC_AUTOSHIP_DAEMON_PID)
    const bootAt = process.env.WECHAT_CC_AUTOSHIP_DAEMON_BOOT
    if (!bootAt || !Number.isSafeInteger(expectedPid) || expectedPid <= 1) return { reason: '自动部署轮须由日用 LaunchAgent 的 daemon 拉起。' }
    try {
      const plistXml = readFileSync(plistPath, 'utf8')
      const target = targetPlan(plistXml)
      const [program, mode] = parseLaunchAgentPlist(plistXml)?.programArguments ?? []
      if (!program || (mode !== '--daemon' && (mode !== 'run' || !samePath(program, target.sidecarPath)))) {
        return { reason: 'LaunchAgent 的启动参数与 App daemon 不符。' }
      }
      if (plan && (!samePath(plan.sidecarPath, target.sidecarPath) || plan.serviceTarget !== target.serviceTarget)) {
        return { reason: 'LaunchAgent 的部署目标发生变化。' }
      }
      const job = spawnSync('/bin/launchctl', ['print', target.serviceTarget], { encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', windowsHide: true })
      if (job.status === 0) {
        const ready = await daemon.deployReadiness()
        if (!ready) return { reason: '无法核对发起自动部署的 daemon。' }
        if (!ready.compiled) return { reason: '源码模式的 daemon 跳过自动部署。' }
        if (matchesLaunchAgent(ready, {
          pid: expectedPid, bootAt, stateDir, plistPath, program, sidecar: target.sidecarPath, supervisedByApp: mode === '--daemon',
        }, parseLoadedLaunchAgent(job.stdout))) return { ready }
      }
    } catch { /* 无法确认 loaded job 时拒绝部署。 */ }
    return { reason: '发起轮次的 daemon、状态目录或可执行文件与日用 LaunchAgent 不匹配。' }
  }

  const installed = (): InstalledVersion | null => {
    try {
      const plan = targetPlan(readFileSync(plistPath, 'utf8'))
      const result = spawnSync(plan.sidecarPath, ['--version'], { encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', windowsHide: true })
      const version = (result.stdout || result.stderr || '').trim()
      return result.status === 0 && version ? parseInstalledVersion(version) : null
    } catch { return null }
  }

  return {
    ...store,
    pendingTransaction: () => transactions.pending()?.message ?? null,
    clearTransaction: transactions.confirm,
    repairLedger: failures.repair,
    platform: process.platform,
    settings,
    writeSettings: patch => patchAutoshipConfig(stateDir, patch),
    repoUrl,
    idleSeconds: () => machineIdleSeconds(),
    async targetMismatch() {
      const result = await checkTarget()
      return 'reason' in result ? result.reason : null
    },
    lock(management) {
      // --unhalt 只确认部署事务和失败账，无需碰中枢或自改锁。
      const selfChangeLock = management ? null : tryAutoshipLock(stateDir)
      if (selfChangeLock && !selfChangeLock.ok) return selfChangeLock
      try {
        const held = acquireDeploymentLock(homeDir)
        if ('busy' in held) {
          selfChangeLock?.release()
          return { ok: false, reason: DEPLOYMENT_BUSY + '本轮跳过。' }
        }
        deployLock = held
        return { ok: true, release() { deployLock = undefined; try { held.release() } finally { selfChangeLock?.release() } } }
      } catch (err) {
        selfChangeLock?.release()
        throw err
      }
    },
    installed,
    notice: daemon.notice,
    log: line => log('AUTOSHIP', line),
    now: Date.now,

    repo(url): AutoshipRepo {
      const workdir = workdirFor()
      const hub = hubPath({ workdir })
      const tree = join(workdir, 'autoship')
      const git = makeGit(nodeGitSpawnSync, hub)
      const mustRun = (args: string[], message: string, cwd?: string) => {
        const result = git.run(args, { cwd })
        if (result.code !== 0) throw new AutoshipPreparationError(message)
        return result.stdout.trim()
      }
      const remoteUrl = () => mustRun(['remote', 'get-url', 'origin'], '无法读取中枢克隆的 origin。')
      const changedFiles = (older: string, newer: string) => {
        const result = git.run(['diff', '--no-renames', '--name-only', '-z', older, newer, '--'])
        return result.code === 0 ? result.stdout.split('\0').filter(Boolean) : null
      }

      return {
        fetchDev() {
          if (!existsSync(hub)) {
            try { mkdirSync(workdir, { recursive: true, mode: 0o700 }) }
            catch { throw new AutoshipPreparationError('无法建立自改工作目录。') }
            // 先在本机初始化，目录/仓库问题和远端网络波动各走各的分支。
            mustRun(['init', 'repo'], '无法建立自改中枢仓库。', workdir)
            mustRun(['remote', 'add', 'origin', '--', url], '无法配置中枢仓库的 origin。')
          }
          const common = mustRun(['rev-parse', '--path-format=absolute', '--git-common-dir'], '无法读取中枢仓库的 Git 目录。')
          const top = mustRun(['rev-parse', '--show-toplevel'], '无法读取中枢仓库的根目录。')
          if (!samePath(top, hub) || !samePath(common, join(hub, '.git'))) throw new AutoshipPreparationError('中枢路径不是独立 Git 仓库。')
          if (remoteUrl() !== url) throw new AutoshipPreparationError('中枢仓库的 origin 与配置的仓库地址不同。')
          return refreshAutoshipDev(git, FETCH_TIMEOUT_MS)
        },
        resolveInstalled(short) {
          const found = git.run(['rev-parse', `--disambiguate=${short}`])
          const matches = found.stdout.trim().split('\n')
          return found.code === 0 && matches.length === 1 && gitObjectId.safeParse(matches[0]).success ? matches[0]! : null
        },
        isAncestor: (older, newer) => git.run(['merge-base', '--is-ancestor', older, newer]).code === 0,
        changedFiles,
        failedTree(candidate, historicalShas) {
          let records: ReturnType<typeof failures.load>
          try {
            records = failures.load()
            if (matchesFailedTree(git, candidate, records)) return true
          } catch (err) { throw new DeploymentLedgerError(err) }
          const selfChangeShas = makeStateStore(stateDir).list()
            .filter(run => run.result === 'deploy_failed' || run.result === 'selftest_failed_rolled_back' || run.deploy?.rolledBack)
            .flatMap(run => run.merge?.sha && gitObjectId.safeParse(run.merge.sha).success ? [run.merge.sha] : [])
          // Tree objects support diff even when the original commit is absent. Include historical records by SHA.
          return [...new Set([...records.map(r => r.tree), ...historicalShas, ...selfChangeShas])].some(prior =>
            changedFiles(prior, candidate)?.every(file => file.endsWith('.md')) === true,
          )
        },
        async ci(sha) {
          const defaults = defaultCiTriageDeps(hub)
          const r = await runCiTriage({ ...defaults, exec: (cmd, args, opts) =>
            cmd === 'git' ? git.run(args, opts) : defaults.exec(cmd, args, opts),
          }, { sha, pushBranch: 'dev' })
          return {
            status: r.exitCode === CI_TRIAGE_EXIT.green ? 'green' : r.pending ? 'pending' :
              r.exitCode === CI_TRIAGE_EXIT.noRun ? 'unavailable' : 'red',
            url: r.report.url,
          }
        },
        async ship(sha, previous) {
          if (!deployLock) throw new Error('自动部署缺少事务锁。')
          if (existsSync(tree)) {
            const common = mustRun(['rev-parse', '--path-format=absolute', '--git-common-dir'], '自动部署工作树路径不是中枢的工作树。', tree)
            const top = mustRun(['rev-parse', '--show-toplevel'], '无法核对自动部署工作树路径。', tree)
            if (!samePath(top, tree) || !samePath(common, join(hub, '.git'))) {
              throw new AutoshipPreparationError('自动部署工作树路径与中枢不匹配。')
            }
            const dirty = mustRun(['status', '--porcelain', '--untracked-files=all'], '无法确认自动部署工作树干净。', tree)
            if (dirty) throw new AutoshipPreparationError('自动部署工作树有未提交的改动，请先检查 <workdir>/autoship。')
            mustRun(['worktree', 'remove', '--force', tree], '无法回收上一轮自动部署工作树。')
          }
          mustRun(['worktree', 'prune'], '无法清理失效的工作树登记。')
          mustRun(['worktree', 'add', '--detach', tree, sha], '无法在选定 SHA 上创建自动部署工作树。')
          let dirtyAfterBuild = false
          const result = await shipFromRepo({
            stateDir, repoRoot: tree, checkedSha: sha, lock: deployLock,
            taskOptions: { waitTasks: true, nonInteractive: true },
            hooks: {
              transactionSha: sha,
              async confirmTarget(plan, previousVersion) {
                try {
                  if (workdirFor() !== workdir || repoUrl() !== url || remoteUrl() !== url) return '仓库配置在构建期间发生变化。'
                } catch { return '无法复核仓库配置。' }
                if (refreshAutoshipDev(git, FINAL_FETCH_TIMEOUT_MS) !== sha) return '远端 dev 已变化或刷新失败，本轮跳过。'
                const treeHead = git.run(['rev-parse', 'HEAD'], { cwd: tree, timeoutMs: 5000 })
                const dirty = git.run(['status', '--porcelain', '--untracked-files=all'], { cwd: tree, timeoutMs: 5000 })
                if (treeHead.code !== 0 || treeHead.stdout.trim() !== sha || dirty.code !== 0 || dirty.stdout.trim()) {
                  dirtyAfterBuild = true
                  return '工作树在构建期间发生变化。'
                }
                if (previousVersion !== previous.version) return '已安装版本发生变化。'
                const tasks = await defaultDeployTaskGate(stateDir, { nonInteractive: true })
                if (tasks) return tasks
                if ((loadavg()[0] ?? 0) / Math.max(1, cpus().length) > DEFAULT_MAX_LOAD_PER_CPU) return '机器负载过高。'
                const target = await checkTarget(plan)
                if ('reason' in target) return target.reason
                if (!target.ready.idle) return 'daemon 正在处理会话、后台工作或关机。'
                if (!target.ready.guarded) return '网络守护未放行。'
                // 就绪返回后只重读开关和时间窗，随后交给备份与换盘。
                const config = settings()
                if (config.auto_ship !== true) return '自动部署已关闭。'
                return autoshipWindowStatus(config, Date.now(), await machineIdleSeconds())
              },
            },
          })
          if (dirtyAfterBuild) throw new AutoshipPreparationError(result.message)
          return result
        },
      }
    },
  }
}
