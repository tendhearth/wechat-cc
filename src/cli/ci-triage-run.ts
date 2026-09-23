/**
 * ci-triage-run.ts —— `wechat-cc ci triage` 的外壳。
 *
 * 纯逻辑在 ci-triage.ts(不碰网络和进程);这里负责**把数据取回来**:`git`
 * 解析 SHA 与改动文件、`gh` 取运行 / 作业 / 失败日志、可选地等与重跑,然后把
 * 结果交给 classifyJob / verdictOf,最后给出退出码。
 *
 * 为什么是一层可注入的 `deps`:自改流水线(spec 2026-09-18-self-change-pipeline)
 * 要在进程内直接调 `runCiTriage`,而不是 spawn 一个 CLI 再解析 stdout;单测也
 * 因此能在没有 `gh` 登录态、没有真 CI 运行的情况下跑完整条路径。
 *
 * 设计:docs/superpowers/specs/2026-09-18-ci-triage-design.md §3。
 */
import { spawnSync } from 'node:child_process'
import flakesJson from './ci-flakes.json'
import {
  classifyJob,
  parseJobLog,
  pickBaseSha,
  validateRegistry,
  verdictOf,
  type Classified,
  type ClassifyCtx,
  type FlakeRegistry,
  type TriageReport,
} from './ci-triage'

export interface ExecResult { code: number | null; stdout: string; stderr: string }

export interface CiTriageDeps {
  exec: (cmd: string, args: string[], opts?: { cwd?: string; timeoutMs?: number }) => ExecResult
  sleep: (ms: number) => Promise<void>
  now: () => number
  /** 进度/诊断行。真跑时走 stderr —— `--json` 的 stdout 必须是干净的一份 JSON。 */
  log: (line: string) => void
  registry: FlakeRegistry
  /** git 仓库根(`git` 与 `gh` 都在这里执行 —— `gh` 靠它认出是哪个 repo)。 */
  cwd: string
}

export interface CiTriageOpts {
  sha?: string
  branch?: string
  wait?: boolean
  rerun?: boolean
  maxReruns?: number
  timeoutMin?: number
}

/** 0 绿 / 1 真红(unknown 也算,没判明白就别放行)/ 2 没有运行或 gh 出错 / 3 是已知 flake。 */
export const CI_TRIAGE_EXIT = { green: 0, real: 1, noRun: 2, flake: 3 } as const

const WORKFLOW = 'CI'
/** 刚推完,Actions 建出运行要几秒到几十秒。 */
const RUN_APPEAR_POLL_MS = 15_000
const RUN_APPEAR_BUDGET_MS = 2 * 60_000
const RUN_POLL_MS = 30_000
/** 等 CI 期间 gh 连续出错几次才放弃(单次抖动不该让 triage 给不出结论)。 */
const WAIT_TRANSIENT_RETRIES = 3
const DEFAULT_TIMEOUT_MIN = 30
const DEFAULT_MAX_RERUNS = 1
const EXEC_TIMEOUT_MS = 120_000

interface RunRow {
  databaseId: number
  status: string
  conclusion: string | null
  headSha: string
  url: string
  createdAt: string
}

interface JobRow {
  name: string
  databaseId: number
  conclusion: string | null
  steps: Array<{ name: string; conclusion: string | null }>
}

/** 非零退出的子进程。带上命令行本身 —— 「gh 没登录」这种事必须说得出是哪一条。 */
class ExecFailure extends Error {
  constructor(readonly cmdline: string, readonly result: ExecResult) {
    const detail = (result.stderr || result.stdout).trim().slice(0, 400)
    super(`\`${cmdline}\` 退出 ${result.code}${detail ? `:${detail}` : ''}`)
    this.name = 'ExecFailure'
  }
}

function run(deps: CiTriageDeps, cmd: string, args: string[]): string {
  const r = deps.exec(cmd, args, { cwd: deps.cwd, timeoutMs: EXEC_TIMEOUT_MS })
  if (r.code !== 0) throw new ExecFailure([cmd, ...args].join(' '), r)
  return r.stdout
}

function runJson<T>(deps: CiTriageDeps, cmd: string, args: string[]): T {
  const out = run(deps, cmd, args)
  try {
    return JSON.parse(out) as T
  } catch {
    throw new ExecFailure([cmd, ...args].join(' '), { code: 0, stdout: out.slice(0, 400), stderr: '输出不是 JSON' })
  }
}

function emptyReport(sha: string, runId: number | null, url: string | null, reruns: number): TriageReport {
  return { sha, runId, url, verdict: 'unknown', base: null, changedFiles: [], jobs: [], reruns }
}

/** 找这个 SHA 上最新的一次 CI 运行。`wait` ⇒ 还没建出来就每 15s 再看,最多 2 分钟。 */
async function findRun(deps: CiTriageDeps, sha: string, wait: boolean): Promise<RunRow | null> {
  const maxAttempts = wait ? 1 + Math.floor(RUN_APPEAR_BUDGET_MS / RUN_APPEAR_POLL_MS) : 1
  for (let attempt = 1; ; attempt++) {
    const rows = runJson<RunRow[]>(deps, 'gh', [
      'run', 'list',
      '--commit', sha,
      '--workflow', WORKFLOW,
      '--json', 'databaseId,status,conclusion,headSha,url,createdAt',
      '--limit', '5',
    ])
    if (rows.length > 0) {
      // 同一个 SHA 上可能有重跑/多次触发,取 createdAt 最新的那条。
      return [...rows].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0]!
    }
    if (attempt >= maxAttempts) return null
    deps.log(`这个 SHA 上还没有 CI 运行,${RUN_APPEAR_POLL_MS / 1000}s 后再看(${attempt}/${maxAttempts - 1})…`)
    await deps.sleep(RUN_APPEAR_POLL_MS)
  }
}

/** 轮询到 `completed`。超过 timeoutMin 就按现状返回(调用方据此退 2)。 */
async function waitForCompletion(
  deps: CiTriageDeps,
  runId: number,
  timeoutMin: number,
): Promise<{ status: string; conclusion: string | null }> {
  const deadline = deps.now() + timeoutMin * 60_000
  // 等 CI 的几分钟里 gh 偶尔会抽一下(2026-09-18 真机:一次 TLS handshake timeout
  // 就让整条 triage 报 unknown)。连着错满 WAIT_TRANSIENT_RETRIES 次才算真出错。
  let transientErrors = 0
  for (;;) {
    let s: { status: string; conclusion: string | null }
    try {
      s = runJson<{ status: string; conclusion: string | null }>(deps, 'gh', [
        'run', 'view', String(runId), '--json', 'status,conclusion',
      ])
      transientErrors = 0
    } catch (err) {
      if (!(err instanceof ExecFailure) || ++transientErrors > WAIT_TRANSIENT_RETRIES) throw err
      deps.log(`gh 暂时不通(${transientErrors}/${WAIT_TRANSIENT_RETRIES}),${RUN_POLL_MS / 1000}s 后再问一次:${err.message.split('\n')[0]?.slice(0, 160)}`)
      await deps.sleep(RUN_POLL_MS)
      continue
    }
    if (s.status === 'completed') return s
    if (deps.now() >= deadline) {
      deps.log(`等了 ${timeoutMin} 分钟运行还没结束(status=${s.status})——先不给结论。`)
      return s
    }
    await deps.sleep(RUN_POLL_MS)
  }
}

/** 一次失败运行的全部取数 + 分类。 */
function triageFailedRun(
  deps: CiTriageDeps,
  sha: string,
  branchOf: () => string,
  runId: number,
  secondRun: boolean,
): { base: string; changedFiles: string[]; jobs: TriageReport['jobs'] } {
  const { jobs } = runJson<{ jobs: JobRow[] }>(deps, 'gh', ['run', 'view', String(runId), '--json', 'jobs'])
  const failed = jobs.filter(j => j.conclusion === 'failure')

  // 基线 = 这条分支上「上一次绿」的 headSha(且是本 SHA 的祖先)。找不到就退化
  // 成 <sha>~1 —— 比「什么都没动过」保守,后者会把真红误判成 flake。
  const successRuns = runJson<Array<{ headSha: string; conclusion: string | null }>>(deps, 'gh', [
    'run', 'list',
    '--branch', branchOf(),
    '--workflow', WORKFLOW,
    '--status', 'success',
    '--limit', '30',
    '--json', 'headSha,conclusion',
  ])
  const isAncestor = (a: string, b: string) =>
    deps.exec('git', ['merge-base', '--is-ancestor', a, b], { cwd: deps.cwd, timeoutMs: EXEC_TIMEOUT_MS }).code === 0
  const base = pickBaseSha(successRuns, sha, isAncestor) ?? `${sha}~1`

  const diff = deps.exec('git', ['diff', '--name-only', base, sha], { cwd: deps.cwd, timeoutMs: EXEC_TIMEOUT_MS })
  let changedFiles: string[] = []
  if (diff.code === 0) {
    changedFiles = diff.stdout.split('\n').map(s => s.trim()).filter(Boolean)
  } else {
    // 说出来:空的改动集会让每条失败都往 flake 那边偏。
    deps.log(`git diff ${base}..${sha} 失败(${(diff.stderr || '').trim().slice(0, 200)})—— 按「本轮没动过文件」处理,判定会偏向 flake。`)
  }

  const ctx: ClassifyCtx = { changedFiles: new Set(changedFiles), registry: deps.registry, secondRun }
  const out = failed.map(job => {
    const failedStep = job.steps.find(s => s.conclusion === 'failure')?.name ?? null
    const logRes = deps.exec('gh', ['run', 'view', '--job', String(job.databaseId), '--log-failed'], {
      cwd: deps.cwd,
      timeoutMs: EXEC_TIMEOUT_MS,
    })
    if (logRes.code !== 0) {
      // **不要**拿空串去 parseJobLog。空日志解析出来正好是
      // 「没有 FAIL 块、也没有 Test Files 汇总行」——即 __NO_SUMMARY__ 的形状,
      // 于是一次取日志失败(gh 抖一下、超时、ENOBUFS)会被判成
      // flake:node-no-summary,还可能被 --rerun 自动重跑掉一条真红。
      // 取不到日志就是「判不出来」:unknown,verdict 最多到 unknown(退 1)。
      const why = (logRes.stderr || '').trim().split('\n')[0]?.slice(0, 200) || `exit ${logRes.code}`
      deps.log(`取不到「${job.name}」的失败日志(${why})—— 这条按 unknown 记,不会当 flake 重跑。`)
      return {
        name: job.name,
        step: failedStep,
        classified: [{ kind: 'unknown', failure: null, excerpt: `could not fetch log: ${why}` }] as Classified[],
      }
    }
    const parsed = parseJobLog(logRes.stdout, job.name)
    return {
      name: job.name,
      step: failedStep,
      classified: classifyJob({ name: job.name, failedStep }, parsed, ctx),
    }
  })

  return { base, changedFiles, jobs: out }
}

export async function runCiTriage(
  deps: CiTriageDeps,
  opts: CiTriageOpts,
): Promise<{ report: TriageReport; exitCode: 0 | 1 | 2 | 3 }> {
  const maxReruns = opts.maxReruns ?? DEFAULT_MAX_RERUNS
  const timeoutMin = opts.timeoutMin ?? DEFAULT_TIMEOUT_MIN
  const wait = Boolean(opts.wait)
  let sha = opts.sha ?? 'HEAD'
  let reruns = 0
  // 已经找到过的那次运行。放在 try 外面,是为了半路 gh 出错时报告里仍然带着
  // 运行地址 —— 退 2 的那一行如果连 URL 都没有,人得自己回去翻是哪一次。
  let foundRunId: number | null = null
  let foundUrl: string | null = null

  try {
    // 40 位。`gh run list --commit` 拿短 sha 会**安静地**返回空数组,看上去
    // 就像「这次推送根本没有 CI」——2026-09 踩过,写进 ci-and-flakes.md 了。
    sha = run(deps, 'git', ['rev-parse', opts.sha ?? 'HEAD']).trim()

    let cachedBranch: string | undefined = opts.branch
    const branchOf = () => {
      if (cachedBranch === undefined) cachedBranch = run(deps, 'git', ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
      return cachedBranch
    }

    let runRow = await findRun(deps, sha, wait)
    if (!runRow) {
      deps.log(`${sha.slice(0, 8)} 上没有 CI 运行${wait ? '(等满 2 分钟也没出现)' : ''}。`)
      return { report: emptyReport(sha, null, null, reruns), exitCode: CI_TRIAGE_EXIT.noRun }
    }
    foundRunId = runRow.databaseId
    foundUrl = runRow.url

    for (;;) {
      if (runRow.status !== 'completed' && wait) {
        const s = await waitForCompletion(deps, runRow.databaseId, timeoutMin)
        runRow = { ...runRow, status: s.status, conclusion: s.conclusion }
      }
      if (runRow.status !== 'completed') {
        deps.log(wait ? '超时,运行仍在跑。' : '运行还没结束 —— 加 --wait 等它跑完。')
        return {
          report: emptyReport(sha, runRow.databaseId, runRow.url, reruns),
          exitCode: CI_TRIAGE_EXIT.noRun,
        }
      }

      if (runRow.conclusion === 'success') {
        return {
          report: { sha, runId: runRow.databaseId, url: runRow.url, verdict: 'green', base: null, changedFiles: [], jobs: [], reruns },
          exitCode: CI_TRIAGE_EXIT.green,
        }
      }

      const secondRun = reruns > 0
      const { base, changedFiles, jobs } = triageFailedRun(deps, sha, branchOf, runRow.databaseId, secondRun)
      const all: Classified[] = jobs.flatMap(j => j.classified)
      const verdict = verdictOf(all)
      const report: TriageReport = { sha, runId: runRow.databaseId, url: runRow.url, verdict, base, changedFiles, jobs, reruns }

      if (verdict === 'flake' && opts.rerun && reruns < maxReruns) {
        run(deps, 'gh', ['run', 'rerun', String(runRow.databaseId), '--failed'])
        reruns += 1
        report.reruns = reruns
        deps.log(`判成 flake —— 已重跑失败作业(第 ${reruns} 次)。第二次仍红一律算真红。`)
        if (!wait) return { report, exitCode: CI_TRIAGE_EXIT.flake }
        // 重跑刚发出去时 GitHub 那边可能还报 completed;先睡一轮再问,否则会
        // 拿着上一轮的结论直接二次分类(于是「仍红」是假的)。
        await deps.sleep(RUN_POLL_MS)
        const s = await waitForCompletion(deps, runRow.databaseId, timeoutMin)
        runRow = { ...runRow, status: s.status, conclusion: s.conclusion }
        continue
      }

      const exitCode = verdict === 'flake' ? CI_TRIAGE_EXIT.flake : CI_TRIAGE_EXIT.real
      return { report, exitCode }
    }
  } catch (err) {
    if (err instanceof ExecFailure) {
      deps.log(`ci triage: ${err.message}`)
      return { report: emptyReport(sha, foundRunId, foundUrl, reruns), exitCode: CI_TRIAGE_EXIT.noRun }
    }
    throw err
  }
}

/** 登记表:编译进包(JSON import),不靠运行时找得到仓库里的那个文件。 */
export function loadFlakeRegistry(): FlakeRegistry {
  const v = validateRegistry(flakesJson)
  if (!v.ok) throw new Error(`src/cli/ci-flakes.json 不合法:\n${v.errors.join('\n')}`)
  return v.registry
}

export function defaultCiTriageDeps(cwd: string): CiTriageDeps {
  return {
    exec: (cmd, args, opts) => {
      const r = spawnSync(cmd, args, {
        cwd: opts?.cwd ?? cwd,
        encoding: 'utf8',
        timeout: opts?.timeoutMs ?? EXEC_TIMEOUT_MS,
        // `gh run view --log-failed` 的日志能有好几 MB,默认 1MB 会被截断,
        // 截断的日志解析出来是「没有 FAIL 块」,正好是最容易误判的形状。
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      })
      return {
        code: r.status,
        stdout: r.stdout ?? '',
        stderr: r.stderr ?? (r.error ? r.error.message : ''),
      }
    },
    sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
    now: () => Date.now(),
    // stderr:`--json` 的 stdout 得是能直接 JSON.parse 的一份。
    log: (line) => console.error(line),
    registry: loadFlakeRegistry(),
    cwd,
  }
}
