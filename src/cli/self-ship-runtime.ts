import { cpus, loadavg } from 'node:os'
import { join } from 'node:path'
import { augmentedPathEnv } from '../lib/util'
import { readApiInfo } from '../lib/api-info'
import { loadAgentConfig } from '../lib/agent-config'
import { defaultDeployTaskGate, type DeployTaskOptions } from './deploy-task-gate'
import { makeDaemonClient } from './self-change/daemon-client'
import { gitEnv, makeGit, nodeGitSpawnSync } from './self-change/git'
import { deployFromRepo, makeSelftest } from './self-change/index'
import { SELF_CHANGE_DEFAULTS } from './self-change/policy'
import { spawnCollect } from './self-change/runner'
import { runShip, type ShipOpts } from './self-ship'
import { defaultSelftestDeps, runChatSelftest, runWorkbenchSelftest } from './selftest'

/** 手动与自动部署共用的实际接线。自动轮已经 fetch 并验过 dev，构建前再核对工作树。 */
export function shipFromRepo(input: {
  stateDir: string
  repoRoot: string
  taskOptions: DeployTaskOptions
  shipOptions?: ShipOpts
  checkedSha?: string
  confirmTarget?: () => string | null
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

  return runShip({
    tree: () => {
      if (!checkedSha) git.run(['fetch', '-q', 'origin', 'dev'])
      const dirty = git.run(['status', '--porcelain', '--untracked-files=all'])
      const head = git.run(['rev-parse', 'HEAD'])
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
    build: () => build().catch(err => ({ ok: false, detail: err instanceof Error ? err.message : String(err) })),
    deploy: mode => deployFromRepo(stateDir, repoRoot, mode, taskOptions, mode === 'deploy' ? input.confirmTarget : undefined),
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
}
