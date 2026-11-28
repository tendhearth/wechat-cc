import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import z from 'zod'
import { loadAgentConfig } from '../lib/agent-config'
import { readApiInfo } from '../lib/api-info'
import { log } from '../lib/log'
import { readJsonObject, writeFileAtomic } from '../lib/json-file'
import { defaultCiTriageDeps, runCiTriage, CI_TRIAGE_EXIT } from './ci-triage-run'
import { writeSelfChangeConfigPatch } from './self-change/config'
import { makeDaemonClient } from './self-change/daemon-client'
import { makeGit, nodeGitSpawnSync } from './self-change/git'
import { launchAgentPlistPath } from './self-change/index'
import { defaultWorkdir } from './self-change/policy'
import { acquireLock, makeStateStore, selfChangeDir } from './self-change/state'
import { hubPath } from './self-change/steps'
import { planSelfDeploy } from './self-deploy'
import { shipFromRepo } from './self-ship-runtime'
import type { runAutoshipCommand, AutoshipRepo, InstalledVersion } from './self-autoship'

const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
const stateShape = z.object({
  failedShas: z.array(sha).default([]),
  redShas: z.array(sha).default([]),
  fail_streak: z.number().int().nonnegative().default(0),
  halted_at: z.number().int().nonnegative().nullable().default(null),
  halt_reason: z.string().nullable().default(null),
})
const roundShape = z.object({ sha: sha.nullable(), at: z.string(), exitCode: z.number().int(), message: z.string() })

export function autoshipStore(stateDir: string) {
  const dir = selfChangeDir(stateDir)
  const statePath = join(dir, 'autoship-state.json')
  const roundPath = join(dir, 'autoship.json')
  const save = (file: string, value: unknown) => writeFileAtomic(file, JSON.stringify(value) + '\n', { mode: 0o600 })
  // 锁外只能写一轮的结论。失败去重和停机状态只能在共享锁内更新。
  return {
    loadState: () => stateShape.parse(readJsonObject(statePath)),
    saveState: (state: z.infer<typeof stateShape>) => save(statePath, state),
    lastRound: () => existsSync(roundPath) ? roundShape.parse(readJsonObject(roundPath)) : null,
    saveRound: (round: z.infer<typeof roundShape>) => save(roundPath, round),
  }
}

export function parseInstalledVersion(version: string): InstalledVersion {
  const clean = version.trim()
  return { version: clean, sha: clean.match(/\(([a-f0-9]{7,64})\)$/)?.[1] ?? null }
}

function probeInstalled(stateDir: string): InstalledVersion | null {
  const homeDir = homedir()
  try {
    const plan = planSelfDeploy({
      homeDir, stateDir, platform: process.platform, arch: process.arch, uid: process.getuid?.() ?? 501,
      repoRoot: homeDir, plistXml: readFileSync(launchAgentPlistPath(homeDir), 'utf8'), exists: existsSync,
    })
    const result = spawnSync(plan.sidecarPath, ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true })
    const version = (result.stdout || result.stderr || '').trim()
    return result.status === 0 && version ? parseInstalledVersion(version) : null
  } catch { return null }
}

const FETCH_TIMEOUT_MS = 10 * 60_000
const DEV_REF = 'refs/remotes/origin/dev'

export function defaultAutoshipDeps(stateDir: string, sourceRoot: string | null): Parameters<typeof runAutoshipCommand>[0] {
  const settings = () => loadAgentConfig(stateDir).self_change
  const workdirFor = (config: ReturnType<typeof settings>) => resolve(config?.workdir ?? defaultWorkdir(homedir(), process.platform))
  const installed = () => probeInstalled(stateDir)
  const daemon = makeDaemonClient({ readApiInfo: () => readApiInfo(stateDir), fetch })

  return {
    ...autoshipStore(stateDir),
    platform: process.platform,
    settings,
    writeSettings: patch => writeSelfChangeConfigPatch(stateDir, patch),
    repoUrl: config => {
      if (config?.repo_url !== undefined) return config.repo_url.trim() || null
      const hub = hubPath({ workdir: workdirFor(config) })
      for (const cwd of [sourceRoot, hub]) {
        if (!cwd || !existsSync(cwd)) continue
        const origin = makeGit(nodeGitSpawnSync, cwd).run(['remote', 'get-url', 'origin'])
        if (origin.code === 0 && origin.stdout.trim()) return origin.stdout.trim()
      }
      return null
    },
    lock: () => acquireLock(stateDir, process.pid, undefined, undefined, 'autoship'),
    installed,
    recentSelfChangeFailure: sha => makeStateStore(stateDir).list().some(run => run.merge?.sha === sha &&
      (run.result === 'deploy_failed' || run.result === 'selftest_failed_rolled_back' || run.deploy?.rolledBack)),
    notice: daemon.notice,
    log: line => log('AUTOSHIP', line),
    now: Date.now,

    repo(url, config): AutoshipRepo {
      const workdir = workdirFor(config)
      const hub = hubPath({ workdir })
      const tree = join(workdir, 'autoship')
      const git = makeGit(nodeGitSpawnSync, hub)
      const mustRun = (args: string[], message: string, opts?: { cwd?: string; timeoutMs?: number }) => {
        const result = git.run(args, opts)
        if (result.code !== 0) throw new Error(message)
        return result.stdout
      }
      return {
        fetchDev() {
          if (!existsSync(hub)) {
            mkdirSync(workdir, { recursive: true, mode: 0o700 })
            mustRun(['clone', '--', url, 'repo'], '无法建立自改中枢克隆。', { cwd: workdir, timeoutMs: FETCH_TIMEOUT_MS })
          }
          const origin = mustRun(['remote', 'get-url', 'origin'], '无法读取中枢克隆的 origin。').trim()
          // 显式配置变更不能让已有中枢克隆悄悄部署另一个仓库。
          if (origin !== url) throw new Error('中枢克隆的 origin 与配置的仓库地址不同，请核对 self_change.repo_url。')
          mustRun(['fetch', 'origin', `+refs/heads/dev:${DEV_REF}`], '无法从中枢克隆 fetch origin/dev。', { timeoutMs: FETCH_TIMEOUT_MS })
          return sha.parse(mustRun(['rev-parse', '--verify', DEV_REF], '无法解析 origin/dev 的提交。').trim())
        },
        resolveInstalled(short) {
          const found = git.run(['rev-parse', `--disambiguate=${short}`])
          const matches = found.stdout.trim().split('\n')
          return found.code === 0 && matches.length === 1 && sha.safeParse(matches[0]).success ? matches[0]! : null
        },
        isAncestor: (older, newer) => git.run(['merge-base', '--is-ancestor', older, newer]).code === 0,
        changedFiles(older, newer) {
          const result = git.run(['diff', '--no-renames', '--name-only', '-z', older, newer, '--'])
          return result.code === 0 ? result.stdout.split('\0').filter(Boolean) : null
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
          if (existsSync(tree)) {
            const dirty = mustRun(['status', '--porcelain', '--untracked-files=all'], '无法确认自动部署工作树干净。', { cwd: tree })
            if (dirty.trim()) throw new Error('自动部署工作树有未提交的改动，请先检查 <workdir>/autoship。')
            mustRun(['worktree', 'remove', '--force', tree], '无法回收上一轮自动部署工作树。')
          }
          mustRun(['worktree', 'prune'], '无法清理失效的工作树登记。')
          mustRun(['worktree', 'add', '--detach', tree, sha], '无法在选定 SHA 上创建自动部署工作树。')
          return shipFromRepo({
            stateDir, repoRoot: tree, checkedSha: sha,
            taskOptions: { waitTasks: true, nonInteractive: true },
            confirmTarget: () => {
              if (settings()?.auto_ship !== true) return '自动部署已关闭，本轮不换文件。'
              if (installed()?.version !== previous.version) return '已安装版本在本轮检查后发生变化，本轮不换文件。'
              const head = git.run(['rev-parse', '--verify', DEV_REF])
              if (head.code !== 0 || head.stdout.trim() !== sha) return '已核验的 origin/dev 发生变化，本轮不换文件。'
              const treeHead = git.run(['rev-parse', 'HEAD'], { cwd: tree })
              const dirty = git.run(['status', '--porcelain', '--untracked-files=all'], { cwd: tree })
              if (treeHead.code !== 0 || treeHead.stdout.trim() !== sha || dirty.code !== 0 || dirty.stdout.trim()) {
                return '工作树在构建期间发生变化，本轮不换文件。'
              }
              return null
            },
          })
        },
      }
    },
  }
}
