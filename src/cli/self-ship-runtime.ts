import { cpus, homedir, loadavg } from 'node:os'
import { join } from 'node:path'
import { augmentedPathEnv } from '../lib/util'
import { readApiInfo } from '../lib/api-info'
import { loadAgentConfig } from '../lib/agent-config'
import { defaultDeployTaskGate, type DeployTaskOptions } from './deploy-task-gate'
import { makeDaemonClient } from './self-change/daemon-client'
import { gitEnv, makeGit, nodeGitSpawnSync } from './self-change/git'
import { makeRepoDeployment, makeSelftest } from './self-change/index'
import { SELF_CHANGE_DEFAULTS } from './self-change/policy'
import { spawnCollect } from './self-change/runner'
import { runShip, SHIP_EXIT, type ShipOpts, type ShipResult } from './self-ship'
import type { SelfDeployDeps, SelfDeployResult } from './self-deploy'
import { acquireDeploymentLock, DEPLOYMENT_BUSY, deploymentLockPath, deploymentTransactions, type DeploymentLock } from './deployment-transaction'
import { DeploymentLedgerError, deploymentFailures, gitObjectId } from './deployment-failures'
import { defaultSelftestDeps, runChatSelftest, runWorkbenchSelftest } from './selftest'

/** 手动与自动部署共用的实际接线。自动轮已经 fetch 并验过 dev，构建前再核对工作树。 */
export async function shipFromRepo(input: {
  stateDir: string
  repoRoot: string
  taskOptions: DeployTaskOptions
  shipOptions?: ShipOpts
  checkedSha?: string
  lock?: DeploymentLock
  hooks?: Pick<SelfDeployDeps, 'beforeRestart' | 'confirmTarget' | 'transactionSha'>
}) {
  const { stateDir, repoRoot, taskOptions, checkedSha } = input
  const daemon = makeDaemonClient({ readApiInfo: () => readApiInfo(stateDir), fetch })
  const agent = loadAgentConfig(stateDir).self_change
  const git = makeGit(nodeGitSpawnSync, repoRoot)
  const log = (line: string) => console.error(line)

  async function build() {
    const env = checkedSha ? gitEnv({ ...process.env, PATH: augmentedPathEnv() }) : process.env
    if (checkedSha) {
      // 下载依赖也是构建的一部分，在负载、守护与交办任务门之后才开始。
      const r = await spawnCollect('bun', ['install', '--frozen-lockfile'], { cwd: repoRoot, env, timeoutMs: SELF_CHANGE_DEFAULTS.tests_timeout_ms })
      if (r.code !== 0) return { ok: false, detail: `bun install --frozen-lockfile 失败：${(r.stderr || r.stdout).trim().split('\n').slice(-20).join('\n')}` }
    }
    const r = await spawnCollect('bun', ['run', 'build-sidecar'], { cwd: join(repoRoot, 'apps', 'desktop'), env, timeoutMs: SELF_CHANGE_DEFAULTS.tests_timeout_ms })
    return { ok: r.code === 0, detail: (r.stderr || r.stdout).trim().split('\n').slice(-20).join('\n') }
  }

  const homeDir = homedir()
  const held = input.lock ?? acquireDeploymentLock(homeDir)
  if ('busy' in held) return { exitCode: SHIP_EXIT.deploy_failed, message: DEPLOYMENT_BUSY }

  const journal = deploymentTransactions(deploymentLockPath(homeDir), stateDir)

  const deployment = makeRepoDeployment(stateDir, repoRoot, taskOptions, held, input.hooks)
  let targetSha = ''
  let knownSource = false
  let deployed: SelfDeployResult | undefined
  let rolledBack: SelfDeployResult | undefined
  try {
    const pending = journal.pending()
    if (pending) return { exitCode: SHIP_EXIT.deploy_failed, blocked: 'transaction' as const, message: pending.message }
    const result = await runShip({
      tree: () => {
        if (!checkedSha) git.run(['fetch', '-q', 'origin', 'dev'])
        const dirty = git.run(['status', '--porcelain', '--untracked-files=all'])
        const head = git.run(['rev-parse', 'HEAD'])
        targetSha = head.stdout.trim()
        const dev = git.run(['rev-parse', '--verify', 'refs/remotes/origin/dev'])
        const devSha = dev.code === 0 ? dev.stdout.trim() : null
        return {
          dirty: dirty.code === 0 && head.code === 0 ? dirty.stdout : '无法核对工作树状态',
          head: head.stdout.trim(),
          devHead: checkedSha && checkedSha !== devSha ? null : devSha,
        }
      },
      load: () => ({ load1: loadavg()[0] ?? 0, cpus: cpus().length }),
      guard: daemon.guard,
      taskGate: () => defaultDeployTaskGate(stateDir, taskOptions),
      build: async () => {
        const built = await build().catch(err => ({ ok: false, detail: err instanceof Error ? err.message : String(err) }))
        if (built.ok && !checkedSha && gitObjectId.safeParse(targetSha).success) {
          const head = git.run(['rev-parse', 'HEAD'])
          const dirty = git.run(['status', '--porcelain', '--untracked-files=all'])
          knownSource = head.code === 0 && head.stdout.trim() === targetSha && dirty.code === 0 && !dirty.stdout.trim()
        }
        return built
      },
      deploy: async mode => {
        if (mode === 'deploy') return deployed = await deployment(mode)
        return rolledBack = await deployment(mode)
      },
      selftest: makeSelftest({
        selftestExecutor: agent?.selftest_executor ?? SELF_CHANGE_DEFAULTS.selftest_executor,
        selftestProvider: agent?.selftest_provider ?? SELF_CHANGE_DEFAULTS.selftest_provider,
      }, {
        workbench: o => runWorkbenchSelftest(defaultSelftestDeps(stateDir), o),
        chat: o => runChatSelftest(defaultSelftestDeps(stateDir), o),
      }),
      sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
      now: Date.now,
      log,
    }, input.shipOptions)
    if (result.exitCode === SHIP_EXIT.shipped || rolledBack?.ok) journal.finish()
    return recordShipFailure(result, deployed, { automatic: !!checkedSha, knownSource }, stage => {
      deploymentFailures(homeDir).add(git, targetSha, stage)
    }, log)
  } finally {
    if (!input.lock) held.release()
  }
}

export function recordShipFailure(
  result: ShipResult,
  deployed: SelfDeployResult | undefined,
  source: { automatic: boolean; knownSource: boolean },
  record: (stage: string) => void,
  log: (message: string) => void,
): ShipResult {
  if (result.blocked || (!source.automatic && !source.knownSource)) return result
  const gateFailed = deployed?.steps.some(s => !s.ok && ['health', 'plugins', 'polling'].includes(s.name))
  const swapped = deployed?.steps.some(s => s.ok && s.name === 'swap')
  const stage = result.exitCode === SHIP_EXIT.selftest_red ? 'selftest'
    : result.exitCode === SHIP_EXIT.build_failed && source.automatic ? 'build'
    : result.exitCode === SHIP_EXIT.deploy_failed && (source.automatic || (swapped && gateFailed)) ? 'deploy'
    : null
  if (!stage) return result
  try { record(stage); return result }
  catch (err) {
    const ledgerError = new DeploymentLedgerError(err).message
    log(ledgerError)
    return { ...result, ledgerError }
  }
}
