/**
 * pipeline.fixture.ts —— 步骤 / 运行器测试共用的那一套假件。
 *
 * 放在测试文件外面是因为 steps.test.ts、run.test.ts、run.integration.test.ts
 * 要的是**同一套**假件:哪天 PipelineDeps 多一个口子,只有一处要补。
 * (照 src/daemon/bootstrap/social-trio.fixture.ts 的先例。)
 */
import type { TriageReport } from '../ci-triage'
import type { SelfDeployResult } from '../self-deploy'
import type { SelftestReport } from '../selftest'
import type { SelfChangeConfig } from './config'
import type { SelfChangeDecision, DaemonClient } from './daemon-client'
import type { Git, GitResult } from './git'
import type { RunnerInput, RunnerResult } from './runner'
import type { PipelineDeps } from './steps'
import { newState, type SelfChangeState, type StateStore } from './state'
import type { SelfChangeSettings } from '../../lib/agent-config'

export interface Recorded {
  git: string[][]
  exec: string[][]
  /** 同一批 exec,连着 cwd / 超时一起记(`build-sidecar` 必须在 apps/desktop 里跑)。 */
  execOpts: Array<{ cmd: string; args: string[]; cwd: string; timeoutMs: number }>
  runner: RunnerInput[]
  notices: string[]
  asks: string[]
  patches: Partial<SelfChangeSettings>[]
  sleeps: number[]
  deployed: string[]
  rolledBack: string[]
}

export function greenTriage(sha: string, verdict: TriageReport['verdict'] = 'green'): TriageReport {
  return { sha, runId: 42, url: 'https://github.com/x/y/actions/runs/42', verdict, base: null, changedFiles: [], jobs: [], reruns: 0 }
}

export function okSelftest(kind: 'workbench' | 'chat', ok = true): SelftestReport {
  return { ok, kind, target: 'claude', checks: [], durationMs: 1 }
}

export function okDeploy(ok = true): SelfDeployResult {
  return { ok, exitCode: ok ? 0 : 1, steps: [], version: '1.2.3' }
}

export const APPROVE_TEXT = '看过了。\n```json\n{"verdict":"approve","findings":[]}\n```\n'

export function runnerOk(over: Partial<RunnerResult> = {}): RunnerResult {
  // 显式的 undefined 不能盖掉缺省值(`{ text: undefined }` 是假件里最常见的写法)。
  const defined = Object.fromEntries(Object.entries(over).filter(([, v]) => v !== undefined)) as Partial<RunnerResult>
  return { ok: true, sessionId: 'sess-1', text: APPROVE_TEXT, costUsd: 1, turns: 3, stderrTail: [], timedOut: false, ...defined }
}

export function testConfig(over: Partial<SelfChangeConfig> = {}): SelfChangeConfig {
  return {
    repoUrl: 'file:///tmp/remote.git',
    branch: 'dev',
    workdir: '/w',
    implementBudgetUsd: 20,
    reviewBudgetUsd: 5,
    maxTurns: 300,
    maxPerDay: 5,
    approvalTimeoutMs: 60_000,
    selftestExecutor: 'claude',
    selftestProvider: 'claude',
    haltedAt: null,
    haltReason: null,
    failStreak: 0,
    ...over,
  }
}

export function memoryStore(seed: SelfChangeState[] = []): StateStore {
  const rows = new Map<string, SelfChangeState>(seed.map(s => [s.id, s]))
  return {
    load: id => rows.get(id) ?? null,
    save: s => { rows.set(s.id, JSON.parse(JSON.stringify(s)) as SelfChangeState) },
    list: () => [...rows.values()].sort((a, b) => b.startedAt - a.startedAt),
    countSince: ts => [...rows.values()].filter(s => s.startedAt >= ts).length,
  }
}

export interface FakeOpts {
  config?: Partial<SelfChangeConfig>
  /** 返回 undefined = 用缺省的「成功、无输出」。 */
  git?: (args: string[], call: number) => Partial<GitResult> | undefined
  exec?: (cmd: string, args: string[], call: number) => Partial<{ code: number | null; stdout: string; stderr: string }> | undefined
  runner?: (input: RunnerInput, call: number) => Partial<RunnerResult> | undefined
  decisions?: SelfChangeDecision[]
  ask?: () => { hash: string; code: string | null } | null
  health?: boolean
  ciTriage?: (opts: { sha: string; branch: string }) => TriageReport
  deploy?: SelfDeployResult
  rollback?: SelfDeployResult
  selftest?: { workbench: boolean; chat: boolean }
  exists?: (p: string) => boolean
  state?: StateStore
  now?: () => number
}

export function makeFakeDeps(opts: FakeOpts = {}): { deps: PipelineDeps; rec: Recorded; files: Map<string, string> } {
  const rec: Recorded = { git: [], exec: [], execOpts: [], runner: [], notices: [], asks: [], patches: [], sleeps: [], deployed: [], rolledBack: [] }
  const files = new Map<string, string>()
  let gitCalls = 0
  let execCalls = 0
  let runnerCalls = 0
  let decisionCalls = 0

  const git: Git = {
    run(args) {
      rec.git.push(args)
      const r = opts.git?.(args, gitCalls++)
      return { code: r?.code ?? 0, stdout: r?.stdout ?? '', stderr: r?.stderr ?? '' }
    },
  }

  const daemon: DaemonClient = {
    notice: async text => { rec.notices.push(text); return true },
    ask: async prompt => {
      rec.asks.push(prompt)
      return opts.ask ? opts.ask() : { hash: `h${rec.asks.length}`, code: 'AB12' }
    },
    decision: async () => {
      const list = opts.decisions ?? ['allow']
      const d = list[Math.min(decisionCalls++, list.length - 1)] ?? 'allow'
      return d
    },
    health: async () => opts.health ?? true,
  }

  const deps: PipelineDeps = {
    config: testConfig(opts.config),
    state: opts.state ?? memoryStore(),
    git,
    runner: {
      run: async input => {
        rec.runner.push(input)
        return runnerOk(opts.runner?.(input, runnerCalls++) ?? {})
      },
    },
    daemon,
    exec: async (cmd, args, execOpts) => {
      rec.exec.push([cmd, ...args])
      rec.execOpts.push({ cmd, args, cwd: execOpts.cwd, timeoutMs: execOpts.timeoutMs })
      const r = opts.exec?.(cmd, args, execCalls++)
      return { code: r?.code ?? 0, stdout: r?.stdout ?? '', stderr: r?.stderr ?? '' }
    },
    ciTriage: async o => ({ report: opts.ciTriage ? opts.ciTriage(o) : greenTriage(o.sha), exitCode: 0 }),
    deploy: async root => { rec.deployed.push(root); return opts.deploy ?? okDeploy() },
    rollback: async root => { rec.rolledBack.push(root); return opts.rollback ?? okDeploy() },
    selftest: async () => ({
      workbench: okSelftest('workbench', opts.selftest?.workbench ?? true),
      chat: okSelftest('chat', opts.selftest?.chat ?? true),
    }),
    fs: {
      exists: p => (opts.exists ? opts.exists(p) : files.has(p)),
      writeFile: (p, s) => { files.set(p, s) },
      mkdirp: p => { files.set(p, '') },
    },
    now: opts.now ?? (() => 1_700_000_000_000),
    sleep: async ms => { rec.sleeps.push(ms) },
    log: () => {},
    stateDir: '/state',
    homeDir: '/home',
    writeConfigPatch: patch => { rec.patches.push(patch) },
  }

  return { deps, rec, files }
}

/** 假 git:按 args 里包含的字串挑回答,没挑到就是「成功、无输出」。 */
export function gitReply(map: Record<string, string | Partial<GitResult>>): (args: string[]) => Partial<GitResult> | undefined {
  return (args) => {
    const key = args.join(' ')
    for (const [needle, value] of Object.entries(map)) {
      if (key.includes(needle)) return typeof value === 'string' ? { stdout: value } : value
    }
    return undefined
  }
}

export function fakeState(over: Partial<SelfChangeState> = {}): SelfChangeState {
  return { ...newState({ id: 'ab12cd34', request: '给 flake 表加一行', from: 'cli', noDeploy: false, now: 1_700_000_000_000 }), ...over }
}
