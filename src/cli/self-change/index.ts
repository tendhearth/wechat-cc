/**
 * index.ts —— 把流水线的十来个注入口接到**真东西**上的那一层。
 *
 * steps.ts / run.ts 里没有一处直接碰 git、进程、网络、部署或自检 —— 全从
 * `PipelineDeps` 进来,单测才能在没网、没 daemon、没 claude 的机器上跑完整条。
 * 代价是「真件」得有个统一的地方拼,就是这里。cli.ts 只负责解析开关,不负责
 * 知道 `claude -p` 怎么起、plist 在哪儿、回滚用的是哪个文件。
 *
 * 两处值得单独说清楚的:
 *  · **回滚 = 同一份部署计划,只把新二进制指到 `<sidecar>.prev`**,并且
 *    `rollback: false`。不这么写的话,回滚本身失败会再触发一次回滚,
 *    两个坏二进制之间来回换。
 *  · **自检用配置里的 executor / provider**,不是写死的 claude:主人可能把
 *    对话那条路切到了别的后端,自检要验的是他真在用的那一个。
 *
 * 设计:docs/superpowers/specs/2026-09-18-self-change-pipeline-design.md。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { workbenchSubprocessEnv } from '../../core/workbench/subprocess-env'
import { readApiInfo } from '../../lib/api-info'
import { defaultCiTriageDeps, runCiTriage } from '../ci-triage-run'
import { defaultSelfDeployDeps, executeSelfDeploy, planSelfDeploy, type SelfDeployPlan, type SelfDeployResult } from '../self-deploy'
import { defaultSelftestDeps, runChatSelftest, runWorkbenchSelftest, type SelftestReport } from '../selftest'
import type { SelfChangeConfig } from './config'
import { makeDaemonClient } from './daemon-client'
import { makeGit, nodeGitSpawnSync } from './git'
import { makeClaudeRunner, spawnCollect } from './runner'
import type { SelfChangeState } from './state'
import { makeStateStore } from './state'
import { repoPath, type PipelineDeps } from './steps'

/** `launchctl` 那份 plist 的固定位置(和 cli.ts 的 `self deploy` 同一条路径)。 */
export function launchAgentPlistPath(homeDir: string): string {
  return join(homeDir, 'Library', 'LaunchAgents', 'com.wechat-cc.daemon.plist')
}

export interface SelfDeployPlanInput {
  platform: NodeJS.Platform
  arch: string
  homeDir: string
  uid: number
  /** 部署的来源仓库 —— 流水线里**永远是专用克隆**,不是主人的 checkout。 */
  repoRoot: string
  stateDir: string
  plistXml: string | null
  mode: 'deploy' | 'rollback'
}

/**
 * 部署 / 回滚共用的那份计划。
 *
 * 回滚不是「另一套流程」,而是同一份计划换个输入:`planSelfDeploy` 先算出
 * `prevPath`(`self deploy` 换 inode 时留下的上一版),再以它当 `binary` 重算一遍
 * —— 于是 `newBinaryPath === prevPath`,executeSelfDeploy 的那套(preflight →
 * 换 inode → kickstart → 健康门)原样复用。`rollback: false` 是必须的:
 * 回滚失败时不该再自动回滚一次。
 *
 * platform / arch / uid 从参数进来(而不是直接读 process),单测才能在任何平台上
 * 演 darwin —— `planSelfDeploy` 在非 darwin 上直接抛。
 */
export function selfDeployPlanFor(input: SelfDeployPlanInput): SelfDeployPlan {
  const base = {
    platform: input.platform,
    arch: input.arch,
    homeDir: input.homeDir,
    uid: input.uid,
    repoRoot: input.repoRoot,
    stateDir: input.stateDir,
    plistXml: input.plistXml,
  }
  const plan = planSelfDeploy(base)
  if (input.mode === 'deploy') return plan
  return planSelfDeploy({ ...base, binary: plan.prevPath, rollback: false })
}

/** 自检那两条的注入口(生产是 selftest.ts 的两个真跑,测试塞假件)。 */
export interface SelftestRunners {
  workbench: (opts: { executor: string; image: boolean; resume: boolean }) => Promise<SelftestReport>
  chat: (opts: { provider: string; resume: boolean }) => Promise<SelftestReport>
}

/**
 * 部署之后的那道自检门:工作台一条 + 对话一条,executor / provider 都取配置。
 *
 * 工作台那条带 `image`(顺手把附件这条路也验了),两条都带 `resume`(续接是
 * 最容易被改坏又最不容易被单测抓到的一环)。工作台红了照样把对话也跑完 ——
 * 报告里要说清楚是一条红还是两条都红,人才知道该怀疑哪一层。
 */
export function makeSelftest(
  config: SelfChangeConfig,
  runners: SelftestRunners,
): () => Promise<{ workbench: SelftestReport; chat: SelftestReport }> {
  return async () => {
    const workbench = await runners.workbench({ executor: config.selftestExecutor, image: true, resume: true })
    const chat = await runners.chat({ provider: config.selftestProvider, resume: true })
    return { workbench, chat }
  }
}

/** 一条 `gh` / `bun` / `npm` 的上限之外,还给 ci triage 留出等 CI 的时间。 */
const CI_TRIAGE_TIMEOUT_MIN = 30

export interface PipelineDepsOpts {
  /** 宿主 checkout(源码模式)/ null(打包版)。只在专用克隆还没建出来时给 `gh` 兜个底。 */
  repoRoot: string | null
}

/**
 * 真件全家桶。
 *
 * `writeConfigPatch` 故意不给:steps.ts 的 `writePatch` 缺省就是往
 * `STATE_DIR/agent-config.json` 写,少一层转手少一个能说谎的地方。
 */
export function defaultPipelineDeps(stateDir: string, config: SelfChangeConfig, opts: PipelineDepsOpts): PipelineDeps {
  const homeDir = homedir()
  const uid = typeof process.getuid === 'function' ? process.getuid() : 501

  const readPlist = (): string | null => {
    const p = launchAgentPlistPath(homeDir)
    return existsSync(p) ? readFileSync(p, 'utf8') : null
  }

  const runDeploy = async (repoRoot: string, mode: 'deploy' | 'rollback'): Promise<SelfDeployResult> => {
    const plan = selfDeployPlanFor({
      platform: process.platform,
      arch: process.arch,
      homeDir,
      uid,
      repoRoot,
      stateDir,
      plistXml: readPlist(),
      mode,
    })
    return await executeSelfDeploy(plan, defaultSelfDeployDeps())
  }

  return {
    config,
    state: makeStateStore(stateDir),
    // 缺省 cwd 是专用克隆;clone 那一步会显式传 workdir(那时候克隆还不存在)。
    // env 显式过一遍 workbenchSubprocessEnv:和 exec / runner 同一条规矩,
    // 而且写在这儿看得见(gitEnv 里还会再过一次,这是有意的双保险)。
    git: makeGit(nodeGitSpawnSync, repoPath(config), workbenchSubprocessEnv(process.env)),
    runner: makeClaudeRunner({ launch: spawnCollect, env: process.env }),
    daemon: makeDaemonClient({ readApiInfo: () => readApiInfo(stateDir), fetch }),

    // bun / npm。env 去掉 daemon 的凭据(和执行者同一条规矩:跑在克隆里的
    // 任何东西都不该看见 daemon 的 token),超时与 windowsHide 由 spawnCollect 兜。
    exec: async (cmd, args, o) => {
      const r = await spawnCollect(cmd, args, {
        cwd: o.cwd,
        env: workbenchSubprocessEnv(process.env),
        timeoutMs: o.timeoutMs,
      })
      return { code: r.code, stdout: r.stdout, stderr: r.stderr }
    },

    // gh 要在一个 git 仓库里跑才知道该问哪个 repo。克隆的 origin 就是
    // config.repoUrl,是最准的那个;deps 在这里**延迟构造**,因为
    // defaultPipelineDeps 是在 repo 步之前调的,那时候克隆还不存在。
    ciTriage: async (o) => {
      const cwd = existsSync(repoPath(config)) ? repoPath(config) : (opts.repoRoot ?? process.cwd())
      return await runCiTriage(defaultCiTriageDeps(cwd), {
        sha: o.sha,
        branch: o.branch,
        wait: true,
        rerun: true,
        timeoutMin: CI_TRIAGE_TIMEOUT_MIN,
      })
    },

    deploy: (repoRoot) => runDeploy(repoRoot, 'deploy'),
    rollback: (repoRoot) => runDeploy(repoRoot, 'rollback'),

    selftest: makeSelftest(config, {
      workbench: (o) => runWorkbenchSelftest(defaultSelftestDeps(stateDir), o),
      chat: (o) => runChatSelftest(defaultSelftestDeps(stateDir), o),
    }),

    fs: {
      exists: (p) => existsSync(p),
      writeFile: (p, s) => writeFileSync(p, s),
      mkdirp: (p) => { mkdirSync(p, { recursive: true }) },
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (line) => { console.log(line) },
    stateDir,
    homeDir,
  }
}

function mark(v: boolean | null): string {
  return v === null ? '未跑' : v ? '绿' : '红'
}

/**
 * `--json` 之外那份人读的收尾。微信里那条通知由 report 步发,这里是**在终端
 * 里等完整条的人**看的:结果、钱、分支去哪了、失败原文在哪个文件里。
 */
export function formatSelfChangeSummary(s: SelfChangeState): string {
  const cost = s.implement.costUsd + s.review.costUsd
  const lines = [
    `自改 #${s.id} · ${s.result ?? '(未收尾)'} · 停在 ${s.step}`,
    `需求:${s.request}`,
    `分支:${s.branch}${s.merge.sha ? ` → 已合入(${s.merge.sha.slice(0, 8)})` : '(未合入,分支保留)'}`,
    `费用:$${cost.toFixed(2)};修复轮 tests ${s.implement.rounds.tests} / review ${s.implement.rounds.review} / ci ${s.implement.rounds.ci}`,
    s.noDeploy ? '部署:按 --no-deploy 未部署' : `部署:${mark(s.deploy.ok)}${s.deploy.version ? `(${s.deploy.version})` : ''}`,
    `自检:工作台 ${mark(s.selftest.workbench)} · 对话 ${mark(s.selftest.chat)}`,
  ]
  if (s.ci.url) lines.push(`CI:${s.ci.url}`)
  if (s.error) lines.push('', s.error)
  return lines.join('\n')
}
