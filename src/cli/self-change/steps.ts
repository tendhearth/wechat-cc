/**
 * steps.ts —— 流水线的十二个步骤,每步一个 `(state, deps) => StepOutcome` 的函数。
 *
 * 步骤只做**一件事并说出结果**:过了就给 `next`,没过就给 `fail`(整条失败)或
 * `fixRound`(交回执行者重修)。轮数怎么算、失败怎么记、要不要停机,全在
 * run.ts 里 —— 三处修复轮共用一份计数与一份「回到 guard」的路径,散在三个
 * 步骤里迟早会走岔。
 *
 * 所有外界(git / bun / claude / daemon / CI / 部署 / 自检 / 文件系统 / 时间)都从
 * `PipelineDeps` 进来:整条流水线要能在没有网、没有 daemon、没有 claude 的机器上
 * 跑测试。
 *
 * 设计:docs/superpowers/specs/2026-09-18-self-change-pipeline-design.md §流程与闸门。
 */
import { join } from 'node:path'

import type { SelfChangeSettings } from '../../lib/agent-config'
import { formatTriage, relatedSources, stripAnsi, type TriageReport } from '../ci-triage'
import { CI_TRIAGE_EXIT } from '../ci-triage-run'
import type { SelfDeployResult } from '../self-deploy'
import type { SelftestReport } from '../selftest'
import { fixPrompt, implementBrief, parseReviewVerdict, reviewPrompt, revertPrompt } from './brief'
import type { SelfChangeConfig } from './config'
import { writeSelfChangeConfigPatch } from './config'
import type { Git } from './git'
import { FORBIDDEN_EXCEPTIONS, FORBIDDEN_GLOBS, SELF_CHANGE_DEFAULTS, forbiddenPaths } from './policy'
import type { ImplementRunner } from './runner'
import type { DaemonClient } from './daemon-client'
import type { ReviewFinding, SelfChangeState, SelfChangeStep, StateStore } from './state'

export interface StepOutcome {
  ok: boolean
  next?: SelfChangeStep
  /** 整条流水线就此结束(失败码 / `declined` / `approval_timeout`)。 */
  fail?: string
  detail?: string
  /** 交回执行者重修(run.ts 负责计数、调 runner、跳回 guard)。 */
  fixRound?: FixKind
  fixPrompt?: string
}

export type FixKind = 'tests' | 'review' | 'ci'

export interface PipelineDeps {
  config: SelfChangeConfig
  state: StateStore
  git: Git
  runner: ImplementRunner
  daemon: DaemonClient
  /**
   * bun / npm。git 不走这里(有 git.ts)。
   *
   * 接线方(Task 7)**必须**用 `workbenchSubprocessEnv(process.env)` 造 env
   * (daemon 的凭据不能进测试 / 构建子进程),并且带 `windowsHide: true`。
   */
  exec: (cmd: string, args: string[], opts: { cwd: string; timeoutMs: number }) => Promise<{ code: number | null; stdout: string; stderr: string }>
  ciTriage: (opts: { sha: string; branch: string }) => Promise<{ report: TriageReport; exitCode: number }>
  deploy: (repoRoot: string) => Promise<SelfDeployResult>
  rollback: (repoRoot: string) => Promise<SelfDeployResult>
  selftest: () => Promise<{ workbench: SelftestReport; chat: SelftestReport }>
  fs: { exists(p: string): boolean; writeFile(p: string, s: string): void; mkdirp(p: string): void }
  now: () => number
  sleep: (ms: number) => Promise<void>
  log: (line: string) => void
  stateDir: string
  homeDir: string
  /** 停机 / fail_streak 写回 agent-config。缺省是真文件;测试塞假件。 */
  writeConfigPatch?: (patch: Partial<SelfChangeSettings>) => void
}

/** clone / fetch / push 的上限:首次 clone 这个仓库要几分钟。 */
const NETWORK_TIMEOUT_MS = 10 * 60_000
/** 失败输出交回执行者时留多少行。 */
const TAIL_LINES = 200
/** 拍板卡里 diffstat 留多少行。 */
const DIFFSTAT_LINES = 15
/** 拍板轮询间隔。 */
export const APPROVAL_POLL_MS = 20_000
/** 轮询总时长比 daemon 侧的超时多留的余量(卡片超时与本地轮询各算各的钟)。 */
const APPROVAL_GRACE_MS = 30_000
/** 评审会话的轮数上限(有预算封顶,这条只防打转)。 */
const REVIEW_MAX_TURNS = 100

/** 专用克隆的位置。步骤和 run.ts 的修复轮都用这一个。 */
export function repoPath(config: SelfChangeConfig): string {
  return join(config.workdir, 'repo')
}

function briefPath(config: SelfChangeConfig, id: string): string {
  return join(config.workdir, 'briefs', `${id}.md`)
}

export function writePatch(d: PipelineDeps, patch: Partial<SelfChangeSettings>): void {
  if (d.writeConfigPatch) d.writeConfigPatch(patch)
  else writeSelfChangeConfigPatch(d.stateDir, patch)
}

/** 一条 git,失败就抛 —— 步骤用 `guardGit` 把它翻成 StepOutcome。 */
class GitFailed extends Error {
  constructor(readonly args: string[], readonly result: { code: number | null; stdout: string; stderr: string }) {
    super(`git ${args.join(' ')} → ${result.code}\n${result.stderr || result.stdout}`.trim())
  }
}

function git(d: PipelineDeps, args: string[], opts?: { cwd?: string; timeoutMs?: number }): string {
  const cwd = opts?.cwd ?? repoPath(d.config)
  const r = d.git.run(args, { cwd, ...(opts?.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }) })
  if (r.code !== 0) throw new GitFailed(args, r)
  return r.stdout
}

/** git 失败在这一步里是「这一步失败」,不是崩溃 —— 翻成一个带原文的 fail。 */
async function guardGit(fail: string, body: () => Promise<StepOutcome>): Promise<StepOutcome> {
  try {
    return await body()
  } catch (err) {
    if (err instanceof GitFailed) return { ok: false, fail, detail: err.message }
    throw err
  }
}

export function isDirty(d: PipelineDeps): boolean {
  return git(d, ['status', '--porcelain']).trim().length > 0
}

/**
 * 执行者忘了提交不算失败(它常常改完就交差)。这里替它提交,
 * 提交信息说清楚是谁提交的,人回头看 log 时不会以为是执行者干的。
 *
 * 身份:全局配置里有就用主人的;没有(打包机、CI 容器)就临时给一个,
 * 否则 `git commit` 会以 "Please tell me who you are" 整条失败。
 */
export function commitAll(d: PipelineDeps, message: string): void {
  git(d, ['add', '-A'])
  // 两个都要有:只配了 user.email(或只配了 name)的机器上,git 照样拒绝提交。
  const has = (key: string): boolean => {
    const r = d.git.run(['config', '--get', key], { cwd: repoPath(d.config) })
    return r.code === 0 && r.stdout.trim().length > 0
  }
  const identity = has('user.email') && has('user.name')
    ? []
    : ['-c', 'user.name=wechat-cc self-change', '-c', 'user.email=self-change@wechat-cc.local']
  git(d, [...identity, 'commit', '-m', message])
}

/**
 * 报一句进展,并把原话记进 state 的 `notices`。
 * 事后追一条自改为什么这样收场时,人手里得有「当时到底告诉了主人什么」——
 * daemon 那边只有微信记录,state 文件才是这条流水线自己的账。
 */
export async function notify(s: SelfChangeState, d: PipelineDeps, text: string): Promise<void> {
  s.notices.push(text)
  await d.daemon.notice(text)
}

/**
 * 半步之内把 state 写回盘。
 *
 * run.ts 的存盘口径是「每一步前后各一次」,对跑得完的步骤够用;approval 这一步
 * **中间要停几小时等人**,而等的人恰恰要从盘上读 hash(`--approve` / `--list`)。
 */
export function saveNow(s: SelfChangeState, d: PipelineDeps): void {
  s.updatedAt = d.now()
  d.state.save(s)
}

function tail(text: string, lines: number): string {
  const all = stripAnsi(text).split('\n')
  return all.slice(Math.max(0, all.length - lines)).join('\n')
}

/** 注入件抛出来的东西(假件说谎、launchd 环境不对、磁盘满)翻成一行人话。 */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function startOfDay(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

// ── intake ───────────────────────────────────────────────────────────────────

/**
 * 三道门:停机(上次部署 / 自检连续失败)、日配额、daemon 在不在。
 * 三个都算 blocked(退出码 2):不是这次改动的错,重试同样的需求没有意义。
 */
async function intake(s: SelfChangeState, d: PipelineDeps): Promise<StepOutcome> {
  if (d.config.haltedAt) {
    return { ok: false, fail: 'self_change_halted', detail: `${new Date(d.config.haltedAt).toISOString()} 起停机:${d.config.haltReason ?? '未记原因'}(wechat-cc self change --unhalt 解除)` }
  }
  // 自己这条已经被 run.ts 存过盘了,不能把自己算进配额里(否则实际上限少一条)。
  const today = d.state.list().filter(x => x.startedAt >= startOfDay(d.now()) && x.id !== s.id).length
  if (today >= d.config.maxPerDay) {
    return { ok: false, fail: 'self_change_quota', detail: `今天已经跑了 ${today} 条(上限 ${d.config.maxPerDay})` }
  }
  if (!(await d.daemon.health())) {
    return { ok: false, fail: 'daemon_not_running', detail: 'daemon 没起(或 api-info 读不到):没法把进展和拍板卡发给主人' }
  }
  await notify(s, d, `自改 #${s.id} 开始:${s.request.slice(0, 80)}`)
  return { ok: true, next: 'repo' }
}

// ── repo ─────────────────────────────────────────────────────────────────────

/**
 * 把专用克隆恢复成「origin/<branch> 的干净副本,站在 self/<id> 上」。
 * 克隆里的脏改动一律丢掉 —— 这是流水线自己的目录,没有人类改动可丢。
 */
async function repo(s: SelfChangeState, d: PipelineDeps): Promise<StepOutcome> {
  return await guardGit('repo_failed', async () => {
    const workdir = d.config.workdir
    const dir = repoPath(d.config)
    d.fs.mkdirp(workdir)
    if (!d.fs.exists(dir)) {
      git(d, ['clone', d.config.repoUrl, 'repo'], { cwd: workdir, timeoutMs: NETWORK_TIMEOUT_MS })
    } else {
      git(d, ['fetch', 'origin', '--prune'], { timeoutMs: NETWORK_TIMEOUT_MS })
    }
    git(d, ['reset', '--hard'])
    git(d, ['clean', '-fd'])
    git(d, ['checkout', '-B', s.branch, `origin/${d.config.branch}`])
    s.baseSha = git(d, ['rev-parse', `origin/${d.config.branch}`]).trim()

    const install = await d.exec('bun', ['install', '--frozen-lockfile'], { cwd: dir, timeoutMs: SELF_CHANGE_DEFAULTS.tests_timeout_ms })
    if (install.code !== 0) {
      return { ok: false, fail: 'repo_failed', detail: `bun install --frozen-lockfile → ${install.code}\n${tail(install.stderr || install.stdout, 40)}` }
    }

    d.fs.mkdirp(join(workdir, 'briefs'))
    d.fs.writeFile(briefPath(d.config, s.id), implementBrief({ id: s.id, branch: s.branch, forbidden: FORBIDDEN_GLOBS, exceptions: FORBIDDEN_EXCEPTIONS }))
    return { ok: true, next: 'implement' }
  })
}

// ── implement ────────────────────────────────────────────────────────────────

/** 拍板卡里「执行者说」那一节最多留多少字(留尾巴 —— 收尾那段话在最后)。 */
export const SUMMARY_MAX_CHARS = 1500

/** 执行者(或修复轮)最后那段话,截尾巴。空话不覆盖上一轮的。 */
export function summaryOf(text: string): string {
  const trimmed = text.trim()
  return trimmed.slice(-SUMMARY_MAX_CHARS)
}

async function implement(s: SelfChangeState, d: PipelineDeps): Promise<StepOutcome> {
  const dir = repoPath(d.config)
  const res = await d.runner.run({
    cwd: dir,
    prompt: s.request,
    systemPromptFile: briefPath(d.config, s.id),
    budgetUsd: d.config.implementBudgetUsd,
    maxTurns: d.config.maxTurns,
  })
  if (res.sessionId) s.implement.sessionId = res.sessionId
  s.implement.costUsd += res.costUsd
  s.implement.turns += res.turns
  // 执行者最后那段话要原样进拍板卡 —— brief 里就是这么向它承诺的,
  // 主人拿着一份 diffstat 是拍不了板的。
  const summary = summaryOf(res.text)
  if (summary) s.implement.summary = summary
  if (res.stderrTail.length) s.stderrTail = res.stderrTail
  if (!res.ok) return { ok: false, fail: 'implement_failed', detail: `${res.error ?? 'unknown'}${res.timedOut ? '(被超时杀掉)' : ''}\n${res.text.slice(-1000)}` }

  return await guardGit('implement_failed', async () => {
    // 执行者忘了提交不算失败。
    if (isDirty(d)) commitAll(d, `自改 #${s.id}:执行者未提交的改动`)
    const count = Number(git(d, ['rev-list', '--count', `origin/${d.config.branch}..HEAD`]).trim())
    if (!Number.isFinite(count) || count === 0) {
      return { ok: false, fail: 'no_changes', detail: `执行者一个提交都没留下。它最后说:\n${res.text.slice(-1000)}` }
    }
    return { ok: true, next: 'guard' }
  })
}

// ── guard ────────────────────────────────────────────────────────────────────

/** 禁改清单闸门。命中一个就整条失败 —— 这是护栏,不进修复轮。 */
async function guard(s: SelfChangeState, d: PipelineDeps): Promise<StepOutcome> {
  return await guardGit('guard_failed', async () => {
    const changed = git(d, ['diff', '--name-only', `origin/${d.config.branch}...HEAD`])
      .split('\n').map(x => x.trim()).filter(Boolean)
    const hits = forbiddenPaths(changed)
    if (hits.length) {
      return { ok: false, fail: 'forbidden_paths', detail: `改动碰了禁改清单:\n${hits.map(p => `- ${p}`).join('\n')}` }
    }
    return { ok: true, next: 'tests' }
  })
}

// ── tests ────────────────────────────────────────────────────────────────────

const TEST_COMMANDS: ReadonlyArray<{ cmd: string; args: string[] }> = [
  { cmd: 'bun', args: ['run', 'typecheck'] },
  { cmd: 'bun', args: ['run', 'depcheck'] },
  { cmd: 'bun', args: ['run', 'test'] },
  { cmd: 'npm', args: ['run', 'test:node', '--', '--reporter=dot'] },
]

/** 失败输出里认得出的 `FAIL <某个>.test.ts`(先去 ANSI)。 */
const FAIL_FILE_RE = /^\s*FAIL\s+(\S+\.test\.ts)\b/

/** 一段测试输出里红了哪几个测试文件(去重,保持出现顺序)。 */
export function failingTestFiles(output: string): string[] {
  const seen = new Set<string>()
  for (const line of stripAnsi(output).split('\n')) {
    const m = FAIL_FILE_RE.exec(line)
    if (m) seen.add(m[1]!)
  }
  return [...seen]
}

/** 这一轮执行者改了哪些文件。git 问不出来就是 `null`(当「不知道」,不敢判抖动)。 */
function changedFiles(d: PipelineDeps): string[] | null {
  try {
    return git(d, ['diff', '--name-only', `origin/${d.config.branch}...HEAD`])
      .split('\n').map(x => x.trim()).filter(Boolean)
  } catch {
    return null
  }
}

/**
 * 这次红,是不是这轮改动自己造成的。
 *
 * 判「无关」要两个条件都成立:解析得出失败文件,且没有一个文件与这轮改动沾边
 * (`relatedSources`:`x.test.ts` 也算 `x.ts` 的红)。解析不出 FAIL 行(整套被
 * 超时杀掉、进程被 OOM 掉)一样当「无关」—— 那种输出里没有任何指向这次改动的证据。
 *
 * 改动文件列表问不出来 ⇒ 当有关(宁可白走一轮修复轮,也不要把真红当抖动重跑)。
 */
function redLooksRelated(changed: string[] | null, output: string): boolean {
  if (changed === null) return true
  const failing = failingTestFiles(output)
  if (!failing.length) return false
  const changedSet = new Set(changed)
  return failing.some(f => relatedSources(f).some(src => changedSet.has(src)))
}

/**
 * 四条依次跑,第一条红就停(后面那几条在同一个坏状态上跑没有信息量)。
 *
 * 红了不立刻进修复轮:先看红的是哪几个测试文件。一个都跟这轮改动不沾边
 * (或者压根没有 FAIL 行 —— 满载机器上整套超时就是这个样子)⇒ **原样重跑一次**。
 * 重跑绿了就是抖动,记一笔接着往下走;重跑还红,或者红的文件本来就跟改动有关,
 * 才照旧交回执行者。
 *
 * 2026-09-18 真机(f65f4c09):一条「只改这一个文件」的文档改动,整套测试被机器
 * 负载拖超时红了一次,修复轮花 $10 让执行者改了 10 个无关文件(还把 vitest 超时
 * 从 5s 放宽到 20s)。抖动不该由执行者来「修」。
 */
async function tests(s: SelfChangeState, d: PipelineDeps): Promise<StepOutcome> {
  const dir = repoPath(d.config)
  const opts = { cwd: dir, timeoutMs: SELF_CHANGE_DEFAULTS.tests_timeout_ms }
  let changed: string[] | null | undefined
  for (const { cmd, args } of TEST_COMMANDS) {
    const line = `${cmd} ${args.join(' ')}`
    d.log(`[self-change] ${line}`)
    let out = await d.exec(cmd, args, opts)
    if (out.code === 0) continue

    // 只问一次 git:四条命令共用同一份改动文件列表。
    if (changed === undefined) changed = changedFiles(d)
    if (!redLooksRelated(changed, `${out.stdout}\n${out.stderr}`)) {
      d.log(`[self-change] ${line} 红了,但失败文件与本次改动无关 —— 原样重跑一次`)
      const again = await d.exec(cmd, args, opts)
      if (again.code === 0) {
        // state 上有 tests 这一格是 v1.1b 才加的:`--resume` 一条老存盘时它是 undefined。
        if (!s.tests) s.tests = { flakes: [] }
        s.tests.flakes.push(line)
        d.log(`tests: ${line} 第一次红是抖动(失败文件与本次改动无关),重跑绿了`)
        continue
      }
      out = again
    }

    const detail = `$ ${line}\n退出码 ${out.code}\n${tail(`${out.stdout}\n${out.stderr}`, TAIL_LINES)}`
    return { ok: false, fixRound: 'tests', fixPrompt: fixPrompt('tests', detail), detail }
  }
  return { ok: true, next: 'review' }
}

// ── review ───────────────────────────────────────────────────────────────────

function formatFindings(findings: readonly ReviewFinding[]): string {
  return findings.map(f => {
    const where = f.file ? ` ${f.file}${f.line ? `:${f.line}` : ''}` : ''
    return `- [${f.severity}]${where} ${f.summary}`
  }).join('\n')
}

const SCOPE_PREFIX = 'scope:'

/**
 * 评审判的「越界」意见指的是哪几个文件。
 *
 * `file` 优先(评审的输出契约要求带上);没带就从 `scope:<file> …` 的 summary 里
 * 取第一个词。取不出文件名的 `scope:` 意见当普通意见走 —— 没有文件列表的
 * `git checkout -- ` 是个会把整棵树还原掉的危险命令。
 */
function scopedFiles(findings: readonly ReviewFinding[]): string[] {
  const out = new Set<string>()
  for (const f of findings) {
    const summary = f.summary.trim()
    if (!summary.startsWith(SCOPE_PREFIX)) continue
    const file = f.file?.trim() || summary.slice(SCOPE_PREFIX.length).trim().split(/\s/)[0] || ''
    if (file) out.add(file)
  }
  return [...out]
}

/**
 * 独立评审:新会话、只读。
 *
 * 只读是用 `--disallowedTools` 挡的,而那是**执行者自己的**闸门 —— 所以评审完
 * 还要自己验一遍:工作树脏了 / HEAD 动了,就还原,并把这次评审直接按 changes 算。
 * 一个「评审」能改代码,后面三道闸门看到的就不是被评审的那份东西了。
 */
async function review(s: SelfChangeState, d: PipelineDeps): Promise<StepOutcome> {
  const dir = repoPath(d.config)
  const baseRef = `origin/${d.config.branch}`
  let headBefore: string
  try {
    headBefore = git(d, ['rev-parse', 'HEAD']).trim()
  } catch (err) {
    if (err instanceof GitFailed) return { ok: false, fail: 'review_failed', detail: err.message }
    throw err
  }

  const res = await d.runner.run({
    cwd: dir,
    prompt: reviewPrompt({ request: s.request, branch: s.branch, baseRef }),
    budgetUsd: d.config.reviewBudgetUsd,
    maxTurns: REVIEW_MAX_TURNS,
    readOnly: true,
  })
  if (res.sessionId) s.review.sessionId = res.sessionId
  s.review.costUsd += res.costUsd
  if (!res.ok) return { ok: false, fail: 'review_failed', detail: `${res.error ?? 'unknown'}${res.timedOut ? '(被超时杀掉)' : ''}\n${res.text.slice(-1000)}` }

  return await guardGit('review_failed', async () => {
    const tampered = isDirty(d) || git(d, ['rev-parse', 'HEAD']).trim() !== headBefore
    if (tampered) {
      // 必须是 `reset --hard`:`checkout -- .` 只把**索引**刷回工作树,评审要是
      // `git add` 过(改了又暂存、没提交),这一手会把它的改动原封不动留下,
      // 接着强制的 review 修复轮里 commitAll 就把评审的手笔提交进去了。
      git(d, ['reset', '--hard', headBefore])
      git(d, ['clean', '-fd'])
    }

    const parsed = parseReviewVerdict(res.text)
    const findings = tampered
      ? [{ severity: 'important' as const, summary: '评审会话改了工作树,已还原' }, ...parsed.findings]
      : parsed.findings
    s.review.verdict = tampered ? 'changes' : parsed.verdict
    s.review.findings = findings

    const blocking = findings.filter(f => f.severity === 'critical' || f.severity === 'important')
    if (blocking.length) {
      const detail = formatFindings(blocking)
      // 越界(`scope:`)的那几条要的是**还原**,不是接着在那些文件上改。
      const scopeFiles = scopedFiles(blocking)
      const prompt = scopeFiles.length
        ? revertPrompt({ baseRef, files: scopeFiles, detail })
        : fixPrompt('review', detail)
      return { ok: false, fixRound: 'review', fixPrompt: prompt, detail }
    }
    // 判了 `changes` 却一条 critical / important 都列不出来:这不是「只剩 minor 可以放行」,
    // 是评审自己没说清楚。回一轮修复(计数照算,所以最多两轮就到头),
    // 比拿着一句「要改」直接合进 dev 强。
    if (s.review.verdict === 'changes') {
      const minors = findings.filter(f => f.severity === 'minor')
      const detail = minors.length
        ? `评审判了 changes,但没有列出 critical / important。它列出来的是:\n${formatFindings(minors)}`
        : '评审判了 changes,但一条意见都没列出来。请自己复查一遍改动:哪里可能让它这么判?'
      return { ok: false, fixRound: 'review', fixPrompt: fixPrompt('review', detail), detail }
    }
    return { ok: true, next: 'ci' }
  })
}

// ── ci ───────────────────────────────────────────────────────────────────────

/**
 * 推上去让真 CI 跑。强推是安全的:`self/<id>` 是这条流水线私有的分支,
 * 修复轮之后本地 HEAD 会和远端分叉。
 */
async function ci(s: SelfChangeState, d: PipelineDeps): Promise<StepOutcome> {
  return await guardGit('push_failed', async () => {
    git(d, ['push', '-u', '--force', 'origin', s.branch], { timeoutMs: NETWORK_TIMEOUT_MS })
    const sha = git(d, ['rev-parse', 'HEAD']).trim()
    const { report, exitCode } = await d.ciTriage({ sha, branch: s.branch })
    s.ci = { runId: report.runId, url: report.url, verdict: report.verdict, sha }
    if (report.verdict === 'green') return { ok: true, next: 'approval' }
    // 退 2 是「没看到 CI 结果」(压根没有运行、等超时、gh 没登录 / 出错),
    // 不是「改动有问题」。交给执行者修等于白烧一轮预算 —— 这条得人去看。
    if (exitCode === CI_TRIAGE_EXIT.noRun) {
      return {
        ok: false,
        fail: 'ci_unavailable',
        detail: `看不到 CI 结果(ci triage 退 ${exitCode}:没有运行 / 等超时 / gh 出错)。分支 ${s.branch} 已经推上去了,人可以自己去看:\n${formatTriage(report)}`,
      }
    }
    const detail = formatTriage(report)
    return { ok: false, fixRound: 'ci', fixPrompt: fixPrompt('ci', detail), detail }
  })
}

// ── approval ─────────────────────────────────────────────────────────────────

function approvalCard(s: SelfChangeState, d: PipelineDeps, diffstat: string): string {
  const minors = s.review.findings.filter(f => f.severity === 'minor')
  const cost = s.implement.costUsd + s.review.costUsd
  return [
    `自改 #${s.id} 请拍板`,
    '',
    `需求:${s.request}`,
    `分支:${s.branch} → ${d.config.branch}`,
    '',
    // brief 里向执行者承诺过「最后那段话会原样进主人的拍板卡」——
    // 主人看 diffstat 看不出为什么这么改,这一节才是他拍板的依据。
    '执行者说:',
    s.implement.summary || '(它什么都没说)',
    '',
    '改动:',
    diffstat,
    '',
    '测试:typecheck / depcheck / bun test / node test 四条全绿',
    `评审:${s.review.verdict ?? 'unknown'}${minors.length ? `,残余 minor:\n${formatFindings(minors)}` : '(没有残余意见)'}`,
    `CI:${s.ci.url ?? '(没有链接)'}`,
    `费用:$${cost.toFixed(2)}(实现 $${s.implement.costUsd.toFixed(2)} + 评审 $${s.review.costUsd.toFixed(2)})`,
  ].join('\n')
}

/**
 * 卡片没进微信时把别的拍板口说给人听。
 *
 * 2026-09-18 真机:实现 / 测试 / 评审 / CI 全绿之后,拍板卡撞上
 * `ilink/sendmessage errcode=-2: prepare failed`,整条流水线白等到
 * approval_timeout。daemon 现在**不会**因为发不出去就把条目删掉,所以人还有
 * 两条路;问题只剩「他不知道」。notify 自己多半也送不出去(同一条外发链路),
 * 那就让它失败 —— `log` 这一条在终端里是看得见的,而终端正是另一个拍板口。
 */
async function announceUndelivered(s: SelfChangeState, d: PipelineDeps, delivered: boolean): Promise<void> {
  if (delivered) return
  const line = `微信卡没送到(外发不通);桌面权限卡或终端 wechat-cc self change --approve ${s.id} 都能拍板`
  d.log(line)
  await notify(s, d, line)
}

/**
 * 发拍板卡,然后在进程里等。
 *
 * 为什么是轮询而不是一条长连接吊着:中间可能 `self deploy` 换掉 daemon,
 * 任何长连接都会断;轮询每次重读 api-info,换了端口也接得上(见 daemon-client)。
 */
async function approval(s: SelfChangeState, d: PipelineDeps): Promise<StepOutcome> {
  let diffstat: string
  try {
    diffstat = git(d, ['diff', '--stat', `origin/${d.config.branch}...HEAD`])
      .split('\n').slice(0, DIFFSTAT_LINES).join('\n').trimEnd()
  } catch (err) {
    if (err instanceof GitFailed) return { ok: false, fail: 'approval_failed', detail: err.message }
    throw err
  }

  const prompt = approvalCard(s, d, diffstat)
  const asked = await d.daemon.ask(prompt, d.config.approvalTimeoutMs)
  if (!asked) return { ok: false, fail: 'owner_chat_unknown', detail: '拍板卡没发出去(daemon 不知道主人是谁,或者没起)' }
  s.approval.hash = asked.hash
  s.approval.code = asked.code
  s.approval.delivered = asked.delivered
  s.approval.askedAt = d.now()
  // **立刻落盘**:run.ts 的存盘是「每一步前后各一次」,而这一步一等就是几小时。
  // 2026-09-18 真机:hash 只在内存里,盘上还是上一轮的 approval_timeout 和旧
  // hash,`--approve` 的三道门(result===null / step==='approval' / hash 在)
  // 一道都过不了 —— 等于第二条拍板口是个哑弹。
  saveNow(s, d)
  await announceUndelivered(s, d, asked.delivered)

  const deadline = d.now() + d.config.approvalTimeoutMs + APPROVAL_GRACE_MS
  let polledAgain = false
  let reAsked = false
  for (;;) {
    const decision = await d.daemon.decision(s.approval.hash)
    s.approval.decision = decision
    if (decision === 'allow') return { ok: true, next: 'merge' }
    if (decision === 'deny') return { ok: false, fail: 'declined', detail: '主人回了 n' }
    if (decision === 'timeout' || decision === 'undelivered') {
      return { ok: false, fail: 'approval_timeout', detail: `daemon 侧报 ${decision}` }
    }
    if (decision === 'unknown') {
      // unknown 有两种:daemon 正在重启(这一次够不着,下一轮就好了)和
      // daemon 真把 PendingPermissions 丢了(卡没了)。先多等一轮问第二次 ——
      // 部署那一步本来就会把 daemon 换掉,一次 unknown 就重发卡等于主人平白多收一张。
      // 第二次还 unknown 才当卡丢了,重发一次;再丢就别缠着他了。
      if (!polledAgain) {
        polledAgain = true
      } else if (!reAsked) {
        reAsked = true
        const again = await d.daemon.ask(prompt, Math.max(0, deadline - d.now()))
        if (!again) return { ok: false, fail: 'approval_timeout', detail: '拍板卡丢了,重发也没发出去' }
        s.approval.hash = again.hash
        s.approval.code = again.code
        s.approval.delivered = again.delivered
        s.approval.askedAt = d.now()
        // 重发卡换了 hash:盘上那个旧的已经没人认了,`--approve` 会拍空。
        saveNow(s, d)
        await announceUndelivered(s, d, again.delivered)
      } else {
        return { ok: false, fail: 'approval_timeout', detail: '拍板卡两次都丢了(daemon 在重启?)' }
      }
    }
    if (d.now() >= deadline) return { ok: false, fail: 'approval_timeout', detail: `等了 ${Math.round((d.now() - (s.approval.askedAt ?? d.now())) / 60000)} 分钟没等到拍板` }
    await d.sleep(APPROVAL_POLL_MS)
  }
}

// ── merge ────────────────────────────────────────────────────────────────────

/**
 * rebase 到最新的 dev 再 ff 合入。
 *
 * rebase 动了 HEAD 也**不重跑 CI**(spec 的取舍:dev 上并发少,重跑要主人再等
 * 一轮),但要把 `ci_sha ≠ merge_sha` 记下来,报告里说清楚。
 */
async function merge(s: SelfChangeState, d: PipelineDeps): Promise<StepOutcome> {
  return await guardGit('merge_failed', async () => {
    git(d, ['fetch', 'origin'], { timeoutMs: NETWORK_TIMEOUT_MS })
    const rebase = d.git.run(['rebase', `origin/${d.config.branch}`], { cwd: repoPath(d.config) })
    if (rebase.code !== 0) {
      d.git.run(['rebase', '--abort'], { cwd: repoPath(d.config) })
      return { ok: false, fail: 'merge_conflict', detail: `rebase 到 origin/${d.config.branch} 冲突了(分支保留):\n${tail(rebase.stderr || rebase.stdout, 40)}` }
    }
    const head = git(d, ['rev-parse', 'HEAD']).trim()
    s.merge.rebased = head !== s.ci.sha

    git(d, ['checkout', d.config.branch])
    git(d, ['reset', '--hard', `origin/${d.config.branch}`])
    git(d, ['merge', '--ff-only', s.branch])
    git(d, ['push', 'origin', d.config.branch], { timeoutMs: NETWORK_TIMEOUT_MS })
    s.merge.sha = git(d, ['rev-parse', 'HEAD']).trim()

    // 删远端分支失败只记一笔:代码已经在 dev 上了,一个残留分支不值得把整条判失败。
    const del = d.git.run(['push', 'origin', '--delete', s.branch], { cwd: repoPath(d.config), timeoutMs: NETWORK_TIMEOUT_MS })
    if (del.code !== 0) d.log(`[self-change] 删远端分支 ${s.branch} 失败(不影响结果):${del.stderr.trim()}`)

    await notify(s, d, `自改 #${s.id} 已合入 ${d.config.branch}(${s.merge.sha.slice(0, 8)})${s.noDeploy ? ',按 --no-deploy 不部署' : ',开始部署'}`)
    return { ok: true, next: s.noDeploy ? 'report' : 'deploy' }
  })
}

// ── deploy ───────────────────────────────────────────────────────────────────

function bumpFailStreak(d: PipelineDeps): void {
  d.config.failStreak += 1
  writePatch(d, { fail_streak: d.config.failStreak })
}

async function deploy(s: SelfChangeState, d: PipelineDeps): Promise<StepOutcome> {
  const dir = repoPath(d.config)
  const build = await d.exec('bun', ['run', 'build-sidecar'], { cwd: join(dir, 'apps', 'desktop'), timeoutMs: SELF_CHANGE_DEFAULTS.tests_timeout_ms })
  if (build.code !== 0) {
    s.deploy.ok = false
    bumpFailStreak(d)
    return { ok: false, fail: 'deploy_failed', detail: `bun run build-sidecar → ${build.code}\n${tail(build.stderr || build.stdout, 40)}` }
  }

  // `planSelfDeploy` 在 launchagent 找不到 / 不是 app bundle / 非 darwin 上**抛**
  // 而不是返回。不接住的话异常一路跑到 run.ts 的兜底,记成 `crashed` ——
  // 而 `crashed` 既不加 fail_streak 也不停机,于是「连红两次就停机」这条护栏
  // 在最该生效的那一天整条失效。
  let result: SelfDeployResult
  try {
    result = await d.deploy(dir)
  } catch (err) {
    s.deploy.ok = false
    bumpFailStreak(d)
    return { ok: false, fail: 'deploy_failed', detail: `部署没跑起来:${errText(err)}` }
  }
  s.deploy.ok = result.ok
  s.deploy.version = result.version ?? null
  if (!result.ok) {
    bumpFailStreak(d)
    return { ok: false, fail: 'deploy_failed', detail: `${result.diagnostics ?? ''}\n${result.steps.filter(x => !x.ok).map(x => `- ${x.name}: ${x.detail ?? ''}`).join('\n')}`.trim() }
  }
  return { ok: true, next: 'selftest' }
}

// ── selftest ─────────────────────────────────────────────────────────────────

/**
 * 回滚二进制 + 记一次失败。
 *
 * **代码已经在 dev 上了**,回滚回不去 —— 所以 detail 里必须写明这件事,
 * 不然主人看到「已回滚」会以为什么都没发生。
 *
 * 回滚本身也会抛(`planSelfDeploy` 在 launchagent 不对时抛):那比自检红一级
 * 更糟 —— 机器上跑着的还是那个新二进制。归 `deploy_failed`(同样是 HALTABLE,
 * 连着两次就停机),话要说到「需要人」为止。
 */
async function rollBack(s: SelfChangeState, d: PipelineDeps, why: string): Promise<StepOutcome> {
  const stillOnDev = `但 dev 上的提交 ${s.merge.sha?.slice(0, 8) ?? '(未知)'} 还在,需要人处理(改好或 revert)。`
  let rolled: SelfDeployResult
  try {
    rolled = await d.rollback(repoPath(d.config))
  } catch (err) {
    bumpFailStreak(d)
    return {
      ok: false,
      fail: 'deploy_failed',
      detail: `${why};回滚也没跑起来:${errText(err)} —— 机器上跑的还是新二进制,要人手工换回 .prev。${stillOnDev}`,
    }
  }
  bumpFailStreak(d)
  return {
    ok: false,
    fail: 'selftest_failed_rolled_back',
    detail: `${why};二进制已${rolled.ok ? '回滚到上一版' : '回滚失败'}。${stillOnDev}`,
  }
}

/** 自检红 ⇒ 回滚二进制(见 rollBack);全绿 ⇒ fail_streak 归零。 */
async function selftest(s: SelfChangeState, d: PipelineDeps): Promise<StepOutcome> {
  let r: { workbench: SelftestReport; chat: SelftestReport }
  try {
    r = await d.selftest()
  } catch (err) {
    // 自检自己抛了(执行者起不来、daemon 换上去之后接不上):按红了处理。
    // 「跑不出结果」和「跑出来是红的」对这台机器的意思是一样的 —— 新二进制不可信。
    return await rollBack(s, d, `自检没跑完:${errText(err)}`)
  }
  s.selftest.workbench = r.workbench.ok
  s.selftest.chat = r.chat.ok
  if (!r.workbench.ok || !r.chat.ok) {
    const which = [r.workbench.ok ? null : '工作台', r.chat.ok ? null : '对话'].filter(Boolean).join(' / ')
    return await rollBack(s, d, `自检红了(${which})`)
  }
  if (d.config.failStreak !== 0) {
    d.config.failStreak = 0
    writePatch(d, { fail_streak: 0 })
  }
  return { ok: true, next: 'report' }
}

// ── report ───────────────────────────────────────────────────────────────────

function mark(v: boolean | null): string {
  return v === null ? '未跑' : v ? '绿' : '红'
}

async function report(s: SelfChangeState, d: PipelineDeps): Promise<StepOutcome> {
  const cost = s.implement.costUsd + s.review.costUsd
  const lines = [
    `自改 #${s.id} 完成:已合入 ${d.config.branch}(${s.merge.sha?.slice(0, 8) ?? '?'})`,
    `需求:${s.request.slice(0, 80)}`,
    `费用:$${cost.toFixed(2)};修复轮 tests ${s.implement.rounds.tests} / review ${s.implement.rounds.review} / ci ${s.implement.rounds.ci}`,
    s.noDeploy ? '部署:按 --no-deploy 未部署' : `部署:${mark(s.deploy.ok)}${s.deploy.version ? `(${s.deploy.version})` : ''}`,
    `自检:工作台 ${mark(s.selftest.workbench)} · 对话 ${mark(s.selftest.chat)}`,
  ]
  if (s.ci.sha && s.merge.sha && s.ci.sha !== s.merge.sha) {
    lines.push(`注意:CI 跑的是 ${s.ci.sha.slice(0, 8)},合入的是 ${s.merge.sha.slice(0, 8)}(rebase 过,没有重跑 CI)`)
  }
  await notify(s, d, lines.join('\n'))
  return { ok: true, next: 'done' }
}

export const steps: Record<Exclude<SelfChangeStep, 'done'>, (s: SelfChangeState, d: PipelineDeps) => Promise<StepOutcome>> = {
  intake, repo, implement, guard, tests, review, ci, approval, merge, deploy, selftest, report,
}
