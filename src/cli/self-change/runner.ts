/**
 * runner.ts —— 自改流水线的执行者适配(v1 只有 `claude -p`)。
 *
 * 为什么直接起 `claude -p` 而不走工作台:工作台的 Claude 会话强制
 * `plugins: []` + `disableAllHooks`,拿不到 superpowers(brainstorming →
 * writing-plans → 子代理评审),而这几天的功能质量全靠那套流程。`claude -p`
 * 不带 `--bare` 时插件照常加载、Task 子代理可用、`--max-budget-usd` /
 * `--max-turns` 封顶、`--output-format json` 给 session_id 和费用、
 * `--resume` 能把修复轮接回同一个会话。
 *
 * 进程本身的细节都收在这里:env 过滤(daemon 凭据不给执行者 + 摘掉嵌套守卫
 * 的两个变量)、超时(整组 SIGTERM 再 5 s SIGKILL)、stdout 里的 JSON 怎么捞。
 * 步骤代码只看 `RunnerResult`。
 *
 * 设计:docs/superpowers/specs/2026-09-18-self-change-pipeline-design.md §执行者调用。
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { wrapForProcessTree } from '../../lib/jobspawn'

import { workbenchSubprocessEnv } from '../../adapters/executors/subprocess-env'

export interface RunnerInput {
  cwd: string
  prompt: string
  /** `--append-system-prompt-file`:流水线生成的那份「交代」(见 brief.ts)。 */
  systemPromptFile?: string
  budgetUsd: number
  maxTurns: number
  /** 修复轮:接回同一个会话,执行者还记得自己刚才改了什么。 */
  resume?: string
  /** 评审轮:关掉四把写工具。 */
  readOnly?: boolean
  timeoutMs?: number
}

export interface RunnerResult {
  ok: boolean
  sessionId: string | null
  /** 执行者最后那段话(解析不出 JSON 时退回 stdout 尾巴,人要看的就是这个)。 */
  text: string
  costUsd: number
  turns: number
  stderrTail: string[]
  /** 这一轮是被超时杀掉的。调用方据此区分「跑挂了」与「跑完但失败」,不用去认 error 串。 */
  timedOut: boolean
  error?: string
}

/** v1 只有 claude;Codex / Cursor / agy 以后按这个口子加(spec §非目标)。 */
export interface ImplementRunner {
  run(input: RunnerInput): Promise<RunnerResult>
}

export interface ClaudeRunnerDeps {
  /** 注入的进程启动口(生产用 spawnCollect)。不叫 spawn:spawn-windowshide 的 lint 会把注入口当真 spawn 点。 */
  launch: (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<{ code: number | null; stdout: string; stderr: string; timedOut?: boolean }>
  env: NodeJS.ProcessEnv
  /** 缺省 `claude`(走 PATH)。 */
  claudeBin?: string
}

/** 一轮实现 / 评审的兜底上限。真正管钱的是 `--max-budget-usd`,这条只防「挂住不动」。 */
const DEFAULT_RUN_TIMEOUT_MS = 2 * 60 * 60_000
const STDERR_TAIL_LINES = 200
/** 解析不出 JSON 时往 `text` 里塞多少原文 —— 够人看出「claude 说了什么」,又不会把 state 撑爆。 */
const RAW_TEXT_CAP = 4000

/**
 * 末尾那个 `--` 不是装饰:`claude --help` 里 `--disallowedTools <tools...>` 是**变长**选项,
 * 不加 `--` 的话紧跟其后的需求正文会被当成又一个工具名吃掉(评审轮就会没有 prompt)。
 * 2026-09-18 在本机 claude 上验过:`claude mcp list --bogus` 报 unknown option,
 * `claude mcp list -- --bogus` 不报 —— 解析器认 `--`。
 * 同一次探测还确认了 `--max-turns` 与 `--append-system-prompt-file` 虽然没印在 --help 里,但都接受。
 */
/**
 * 只读会话(评审、规划)的锁:2026-10-23 在 claude 2.1.309 上实测过。
 *
 * 以前只是 `--dangerously-skip-permissions` + 关掉四把写工具:Bash 照样全开(能写树外、能 git push、能 curl),
 * porcelain 只查得到树里;主人的用户 MCP 也照样加载 —— 跟 #634 给 Codex 堵上的是同一个洞(整合者评审 #646)。
 * 现在:
 *   - `--restricted`:去掉跑命令的工具(除非 --tools 点名)、不读用户 / 项目 / 本地设置、文件工具关在工作目录里、拒绝 bypassPermissions;
 *   - `--strict-mcp-config`(不给 --mcp-config)⇒ 一个 MCP 都不加载;
 *   - `--tools Read,Grep,Glob,Bash` + `--permission-mode dontAsk` + 只放行 `git diff / log / show`:评审提示词要它
 *     `git diff <base>...HEAD`、`git log`,别的命令一律被拒(实测 `touch` 被拒、`git log` 能跑、工具只剩这四个)。
 * 不再带 `--dangerously-skip-permissions`(restricted 本来就拒它)。
 * 那三条 git 自带的写口(`--output` / `--ext-diff` / `--textconv`)单独拒掉,见常量里的注释。
 */
export const CLAUDE_READONLY_LOCKDOWN = [
  '--restricted', '--strict-mcp-config',
  '--tools', 'Read,Grep,Glob,Bash',
  '--permission-mode', 'dontAsk',
  '--allowedTools', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)',
  // 放行的那三条自己也能写 / 能跑东西:`--output=<任意路径>` 写文件,`--ext-diff` / `--textconv` 跑仓库配置里的外部程序
  // (整合者评审 #647)。实测:通配的拒绝规则拦得住选项出现在中间的写法(`git diff HEAD~1 --stat --output=…`);
  // 重定向(`> file`)、`;` / `&&` 串命令本来就被拒。
  '--disallowedTools', 'Bash(*--output*)', 'Bash(*--ext-diff*)', 'Bash(*--textconv*)',
] as const

export function claudeArgs(input: RunnerInput): string[] {
  return [
    '-p', '--output-format', 'json',
    ...(input.readOnly ? CLAUDE_READONLY_LOCKDOWN : ['--dangerously-skip-permissions']),
    '--max-budget-usd', String(input.budgetUsd),
    '--max-turns', String(input.maxTurns),
    ...(input.resume ? ['--resume', input.resume] : []),
    ...(input.systemPromptFile ? ['--append-system-prompt-file', input.systemPromptFile] : []),
    // `--allowedTools` 吃变长参数:靠下面这个 `--` 收住,不然需求正文会被当成又一个工具名。
    '--', input.prompt,
  ]
}

/**
 * 执行者的 env:工作台那套过滤(摘掉 WECHAT_ / HEARTH_ / WXVAULT_ / WXGRAPH_
 * 这些 daemon 凭据)之外,还要删掉 `CLAUDECODE` 与 `CLAUDE_CODE_ENTRYPOINT` ——
 * 从一个 Claude Code 会话里起流水线时,这两个变量会让子进程被嵌套守卫直接拒掉。
 */
export function runnerEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = workbenchSubprocessEnv(base)
  delete env.CLAUDECODE
  delete env.CLAUDE_CODE_ENTRYPOINT
  return env
}

export interface ClaudeJson {
  sessionId: string | null
  text: string
  costUsd: number
  turns: number
  isError: boolean
  subtype: string | null
}

/**
 * `--output-format json` 打的是一份 JSON,但 stdout 上可能先有插件 / 告警的噪声行,
 * 后面也可能跟着别的 JSON(比如某个工具自己打的一行对象)。所以从后往前找,
 * **优先**认带 `session_id` 或 `type: "result"` 的那一行(那才是结果信封);
 * 没有就退回最后一个对象形状的行;再不行试整份 stdout(pretty-print 的多行 JSON)。
 */
export function parseClaudeJson(stdout: string): ClaudeJson | null {
  const lines = stdout.split('\n')
  let fallback: Record<string, unknown> | null = null
  for (let i = lines.length - 1; i >= 0; i--) {
    const obj = asObject(lines[i]!)
    if (!obj) continue
    if (typeof obj.session_id === 'string' || obj.type === 'result') return shape(obj)
    fallback ??= obj
  }
  if (fallback) return shape(fallback)
  const whole = asObject(stdout)
  return whole ? shape(whole) : null
}

function asObject(text: string): Record<string, unknown> | null {
  const t = text.trim()
  if (!t.startsWith('{')) return null
  try {
    const v: unknown = JSON.parse(t)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function shape(o: Record<string, unknown>): ClaudeJson {
  return {
    sessionId: typeof o.session_id === 'string' ? o.session_id : null,
    text: typeof o.result === 'string' ? o.result : '',
    costUsd: typeof o.total_cost_usd === 'number' && Number.isFinite(o.total_cost_usd) ? o.total_cost_usd : 0,
    turns: typeof o.num_turns === 'number' && Number.isFinite(o.num_turns) ? o.num_turns : 0,
    isError: o.is_error === true,
    subtype: typeof o.subtype === 'string' ? o.subtype : null,
  }
}

function tail(text: string, lines: number): string[] {
  if (!text) return []
  const all = text.split('\n')
  return all.slice(Math.max(0, all.length - lines))
}

export function makeClaudeRunner(deps: ClaudeRunnerDeps): ImplementRunner {
  return {
    async run(input: RunnerInput): Promise<RunnerResult> {
      const cmd = deps.claudeBin ?? 'claude'
      let out: { code: number | null; stdout: string; stderr: string; timedOut?: boolean }
      try {
        out = await deps.launch(cmd, claudeArgs(input), {
          cwd: input.cwd,
          env: runnerEnv(deps.env),
          timeoutMs: input.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
        })
      } catch (err) {
        // 起不来(claude 不在 PATH 上 / 权限不对)和「跑了但失败」要分得开:
        // 前者重试多少次都一样,步骤代码据此不进修复轮。
        return { ok: false, sessionId: null, text: '', costUsd: 0, turns: 0, stderrTail: [String(err instanceof Error ? err.message : err)], timedOut: false, error: 'claude_spawn_failed' }
      }
      const parsed = parseClaudeJson(out.stdout)
      // subtype 缺省是 'success';不是 success(或 is_error)都算这一轮没成。
      const ok = out.code === 0 && !!parsed && !parsed.isError && (parsed.subtype === null || parsed.subtype === 'success')
      const result: RunnerResult = {
        ok,
        sessionId: parsed?.sessionId ?? null,
        // 解析出来了就用 result 字段(哪怕是空串)—— 否则空 result 会把整份 JSON 信封倒进正文。
        text: parsed ? parsed.text : out.stdout.trim().slice(-RAW_TEXT_CAP),
        costUsd: parsed?.costUsd ?? 0,
        turns: parsed?.turns ?? 0,
        stderrTail: tail(out.stderr, STDERR_TAIL_LINES),
        timedOut: out.timedOut === true,
      }
      if (!ok) result.error = parsed?.subtype && parsed.subtype !== 'success' ? parsed.subtype : `claude_exit_${out.code}`
      return result
    },
  }
}

/**
 * 调模型之前先看网络守护(红线:直连官方端点会封号;Claude / Codex 都是需要保护的官方端点)。
 * 2026-10-23 之前自改从来不看:守护在 daemon 里,而自改的执行者是 CLI 直接起的 `claude -p`,绕过了它。
 * 守护开着且不安全 ⇒ 这一轮不起进程,回 `network_unprotected`;读不到守护状态 ⇒ 同样不起(缺省往拒绝兜底);
 * 主人自己关了守护 ⇒ 照常。
 */
export function guardedRunner(inner: ImplementRunner, guard: () => Promise<{ enabled: boolean; safe: boolean; detail: string } | null>): ImplementRunner {
  return {
    async run(input) {
      const g = await guard().catch(() => null)
      if (!g || (g.enabled && !g.safe)) {
        const why = !g ? '读不到网络守护的状态(daemon 不通?)' : `网络守护说现在不安全:${g.detail}`
        return { ok: false, sessionId: null, text: `${why} —— 先不调模型,等网络受保护了再 --resume`, costUsd: 0, turns: 0, stderrTail: [], timedOut: false, error: 'network_unprotected' }
      }
      return await inner.run(input)
    },
  }
}

// ── 评审换人:Codex 只读评审(CC 自己跑开发设计稿 §4.2 / §6 第 2 步) ─────────────────
//
// 评审跟实现不是同一家,才有两路会话那种互相纠正(设计稿 §3 第 3 条)。主人 10-23:谁写谁审「应该让 CC 来决定」
// ⇒ chooseReviewer 按谁此刻能用来挑,挑的理由记进 state、上拍板卡。
//
// `codex exec -s read-only`:沙箱只读,能读代码、跑只读命令,写不了工作树(流水线照旧在评审后查 HEAD / 工作区有没有被动过)。
// `--json` 是一行一个事件(2026-10-23 在 codex-cli 0.164.0 上实测):`thread.started.thread_id`、
// `item.completed` 里 `item.type === 'agent_message'` 的 `text`(取最后一条)、`turn.completed.usage`;
// `item.type === 'error'` 是 hooks / MCP 的噪声,不算失败。Codex 走订阅,不报美元 ⇒ costUsd 记 0。

/**
 * 只读沙箱只管文件写,管不住 MCP 工具:主人的 ~/.codex 里装着插件带的 MCP(2026-10-23 本机:cua_repl / node_repl 是 enabled,
 * 能驱动电脑和浏览器)。`-c mcp_servers={}` 在 0.164.0 上**没用**(插件的那几个照样在)。实测管用的是:不读主人的
 * config.toml(`--ignore-user-config`,登录照旧用 CODEX_HOME)+ 关掉插件 / 浏览器 / 电脑操作 / apps / hooks 这几个功能。
 * 关完以后实跑一次问它能调什么:cua_repl、node_repl、computer-use 都没了,hooks 的噪声也没了;剩下的是 codex 自带的
 * (exec_command 在只读沙箱里、spawn_agent 之类;web__run / image_gen 下面也关了)—— 已知,写进 self-change.md。
 */
// 联网搜索和画图也关掉(整合者评审 #630):评审的提示词里有 diff,`web__run` 是唯一会把仓库内容带出这台机器的内置工具。
// web_search 没有 feature 开关,是配置项:`-c web_search="disabled"`;画图是 feature `image_generation`。10-23 实跑核过:关完以后
// 工具表里没有 web__run / image_gen 了。
export const CODEX_REVIEW_LOCKDOWN = ['--ignore-user-config', '--disable', 'plugins', '--disable', 'browser_use', '--disable', 'computer_use', '--disable', 'apps', '--disable', 'hooks', '--disable', 'image_generation', '-c', 'web_search="disabled"']

export function codexReviewArgs(input: RunnerInput): string[] {
  return ['exec', ...CODEX_REVIEW_LOCKDOWN, '-s', 'read-only', '-C', input.cwd, '--json', '--', input.prompt]
}

export interface CodexJson { threadId: string | null; text: string; failed: string | null; turns: number }

export function parseCodexJson(stdout: string): CodexJson {
  let threadId: string | null = null
  let text = ''
  let failed: string | null = null
  let turns = 0
  for (const line of stdout.split('\n')) {
    const o = asObject(line)
    if (!o) continue
    if (o.type === 'thread.started' && typeof o.thread_id === 'string') threadId = o.thread_id
    else if (o.type === 'turn.completed') turns++
    else if (o.type === 'turn.failed') failed = typeof (o.error as { message?: unknown } | undefined)?.message === 'string' ? (o.error as { message: string }).message : 'turn_failed'
    else if (o.type === 'item.completed') {
      const item = o.item as { type?: unknown; text?: unknown } | undefined
      if (item?.type === 'agent_message' && typeof item.text === 'string') text = item.text
    }
  }
  return { threadId, text, failed, turns }
}

export interface CodexRunnerDeps {
  launch: ClaudeRunnerDeps['launch']
  env: NodeJS.ProcessEnv
  /** 缺省 `codex`(走 PATH)。 */
  codexBin?: string
}

/** 只做评审:不是 readOnly 的调用一律拒(实现仍然只给 Claude,Codex 写工作树那条路没验过)。 */
export function makeCodexReviewRunner(deps: CodexRunnerDeps): ImplementRunner {
  return {
    async run(input: RunnerInput): Promise<RunnerResult> {
      const fail = (error: string, stderrTail: string[] = []): RunnerResult => ({ ok: false, sessionId: null, text: '', costUsd: 0, turns: 0, stderrTail, timedOut: false, error })
      if (!input.readOnly) return fail('codex_runner_review_only')
      let out: { code: number | null; stdout: string; stderr: string; timedOut?: boolean }
      try {
        out = await deps.launch(deps.codexBin ?? 'codex', codexReviewArgs(input), {
          cwd: input.cwd,
          env: runnerEnv(deps.env),
          timeoutMs: input.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
        })
      } catch (err) {
        return fail('codex_spawn_failed', [String(err instanceof Error ? err.message : err)])
      }
      const parsed = parseCodexJson(out.stdout)
      const ok = out.code === 0 && !parsed.failed && parsed.text.trim() !== ''
      const result: RunnerResult = {
        ok,
        sessionId: parsed.threadId,
        text: parsed.text || out.stdout.slice(-RAW_TEXT_CAP),
        costUsd: 0,
        turns: parsed.turns,
        stderrTail: tail(out.stderr, STDERR_TAIL_LINES),
        timedOut: out.timedOut === true,
      }
      if (!ok) result.error = parsed.failed ?? (parsed.text ? `codex_exit_${out.code}` : 'codex_no_answer')
      return result
    },
  }
}

export interface ReviewerChoice { id: 'codex' | 'claude'; why: string }

/**
 * 谁来审:实现是 Claude ⇒ 优先 Codex(不同家);Codex 不能用(没装 / 没登录)⇒ 退回 Claude 的另一个只读会话,
 * 并照实写理由。`codexLoggedIn` 由调用方给(生产 = `codex login status` 退 0)。
 */
export function chooseReviewer(o: { codexLoggedIn: boolean }): ReviewerChoice {
  if (o.codexLoggedIn) return { id: 'codex', why: '实现是 Claude,评审换 Codex(不同家才互相挑得出错)' }
  return { id: 'claude', why: 'Codex 没装或没登录,退回 Claude 的另一个只读会话(同一家,互相纠正弱一些)' }
}

/** SIGTERM 之后留给执行者把 JSON 打完的时间,过了就硬杀。 */
export const KILL_GRACE_MS = 5_000

/**
 * 生产用的 spawn:`windowsHide`、全量收 stdout/stderr、到点先 SIGTERM 再 5 s SIGKILL。
 *
 * `detached: true` + 杀**进程组**(`process.kill(-pid, sig)`)是必须的:`claude -p`
 * 自己会起 MCP 服务端和 Task 子代理,只杀 `child.pid` 的话它们会变成孤儿继续跑、
 * 继续烧预算 —— 工作台那两处(claude-workbench-process.ts / acp-agent-provider.ts)
 * 早就是这个写法,这里照抄。SIGTERM 先发是因为 claude 收到 SIGTERM 还会把那份 JSON
 * 打完,一上来就 SIGKILL 就什么都拿不到。
 *
 * Windows 没有进程组,所以那条 else 分支只杀 `claude` 本身、MCP 与子代理留下继续烧
 * 预算(2026-09-23 真机复现)。修法在 spawn 这一侧:`wrapForProcessTree` 在 win32 上
 * 套一层 `cc-jobspawn`,杀它等于杀整棵树 —— 上面的 `killGroup` 一行没改。
 *
 * 单测注入假件;这一条另有一个真进程的测试钉住「孙子进程也死了」。
 */
export async function spawnCollect(
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return await new Promise((resolve, reject) => {
    // win32 上没有进程组,`killGroup` 下面那条 else 分支只杀 `claude` 本身 —— 套一层
    // cc-jobspawn,它一死内核就把整棵树收掉(见 src/lib/jobspawn.ts)。POSIX 原样:
    // detached + `kill(-pid)` 本来就好使,不多套一层进程。
    const wrapped = wrapForProcessTree(cmd, args)
    const child = nodeSpawn(wrapped.command, wrapped.args, {
      cwd: opts.cwd,
      env: opts.env,
      windowsHide: true,
      // 自成一个进程组,这样 -pid 能把 claude 起的 MCP / 子代理一起带走。
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let hardTimer: ReturnType<typeof setTimeout> | null = null
    child.stdout?.on('data', (c: Buffer) => { stdout += c.toString() })
    child.stderr?.on('data', (c: Buffer) => { stderr += c.toString() })
    const killGroup = (sig: NodeJS.Signals): void => {
      // 已经退干净了就是 ESRCH,吞掉:这条路上「没这个进程了」正是我们要的结果。
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, sig)
        else child.kill(sig)
      } catch { /* ESRCH / 组已空 */ }
    }
    const softTimer = setTimeout(() => {
      timedOut = true
      killGroup('SIGTERM')
      hardTimer = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS)
    }, opts.timeoutMs)
    const done = (): void => {
      clearTimeout(softTimer)
      if (hardTimer) clearTimeout(hardTimer)
    }
    child.on('error', (err) => { done(); reject(err) })
    child.on('close', (code) => { done(); resolve({ code, stdout, stderr, timedOut }) })
  })
}
