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

import { workbenchSubprocessEnv } from '../../core/workbench/subprocess-env'

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
  spawn: (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<{ code: number | null; stdout: string; stderr: string; timedOut?: boolean }>
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
export function claudeArgs(input: RunnerInput): string[] {
  return [
    '-p', '--output-format', 'json', '--dangerously-skip-permissions',
    '--max-budget-usd', String(input.budgetUsd),
    '--max-turns', String(input.maxTurns),
    ...(input.resume ? ['--resume', input.resume] : []),
    ...(input.systemPromptFile ? ['--append-system-prompt-file', input.systemPromptFile] : []),
    ...(input.readOnly ? ['--disallowedTools', 'Edit,Write,MultiEdit,NotebookEdit'] : []),
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
        out = await deps.spawn(cmd, claudeArgs(input), {
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
 * 单测注入假件;这一条另有一个真进程的测试钉住「孙子进程也死了」。
 */
export async function spawnCollect(
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return await new Promise((resolve, reject) => {
    const child = nodeSpawn(cmd, args, {
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
