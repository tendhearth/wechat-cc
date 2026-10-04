/**
 * EXPERIMENT ONLY — reply-once harness 的 Codex 真模型沙盒(回复交付第 4 步,2026-10-03)。daemon 不 import 它。
 *
 * 真 codex CLI(主人装的那个)+ 真模型(api.openai.com,需要保护的端点)+ **生产的** Codex provider 与 wechat MCP 入口,
 * 背后是本进程里的假 internal API(只记账)。主人的东西一样都不碰:
 *
 *   - **CODEX_HOME 是临时目录**:只从 `~/.codex/auth.json` **复制**一份登录(只读源文件,不改它);config.toml 是这里写的
 *     最小配置(模型 + 思考强度),不继承主人的 MCP / hooks / AGENTS.md / skills / 项目信任。HOME 也指到临时目录。
 *     复制前检查 `last_refresh` 在 7 天内 —— codex 超过 8 天才主动刷新令牌;刷新会轮换 refresh token,让主人那份失效,
 *     所以离刷新窗口太近就拒跑(宁可不跑,不动主人的登录)。
 *   - 工作目录是临时目录;沙盒 **read-only**、approval never(不给 --dangerously:它会连 shell 的沙盒一起关掉)。
 *     wechat MCP 用 codex 自己的 `mcp_servers.wechat.default_tools_approval_mode = "approve"` 放行(生产是 bypass)。
 *     strict 探针(`approveMcp: false`)不放行,照生产 strict 的样子看 codex 怎么拒 MCP。
 *   - 每一轮之前 `bx status --json` 必须 protected + healthy(assertBxProtected),否则整批中止。
 *   - 不发微信、不碰 projects.json / 记忆 / 对话:MCP 的 WECHAT_INTERNAL_API 指向假 API,状态目录是临时的。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Codex, type Thread, type ThreadEvent, type ThreadOptions } from '@openai/codex-sdk'
import type { CodexFactory } from '../../../src/core/codex-agent-provider'
import { codexCallTarget } from '../../../src/lib/codex-target'
import { classifyCall } from '../../../src/lib/call-classifier'

/** codex 超过 8 天才主动刷新(TOKEN_REFRESH_INTERVAL);留一天余量。 */
const MAX_AUTH_AGE_MS = 7 * 24 * 3600_000

export interface CodexSandbox { home: string; codexHome: string; workdir: string }

/**
 * 建沙盒:临时 HOME / CODEX_HOME / 工作目录;复制登录;写最小 config.toml。
 * 源 auth.json 只读一次(复制),绝不写。
 */
export function makeCodexSandbox(root: string, opts: { model: string; effort: string; sourceAuth?: string; now?: number }): CodexSandbox {
  const src = opts.sourceAuth ?? join(homedir(), '.codex', 'auth.json')
  if (!existsSync(src)) throw new Error(`[reply-once/codex] 没有 ${src} —— 不跑真模型`)
  const auth = JSON.parse(readFileSync(src, 'utf8')) as { last_refresh?: string; auth_mode?: string }
  const last = auth.last_refresh ? Date.parse(auth.last_refresh) : NaN
  if (auth.auth_mode === 'chatgpt' && !(Number.isFinite(last) && (opts.now ?? Date.now()) - last < MAX_AUTH_AGE_MS)) {
    throw new Error('[reply-once/codex] 登录离 codex 自动刷新窗口太近(刷新会轮换主人的 refresh token)—— 拒跑')
  }
  const home = join(root, 'home')
  const codexHome = join(root, 'codex-home')
  const workdir = join(root, 'work')
  for (const d of [home, codexHome, workdir]) mkdirSync(d, { recursive: true })
  copyFileSync(src, join(codexHome, 'auth.json'))
  writeFileSync(join(codexHome, 'config.toml'), [
    `model = ${JSON.stringify(opts.model)}`,
    'model_provider = "openai"',
    `model_reasoning_effort = ${JSON.stringify(opts.effort)}`,
    '',
  ].join('\n'))
  return { home, codexHome, workdir }
}

/** 这次真的会打到哪里:按沙盒的 CODEX_HOME 读 codex 自己的配置(守护同一套判定)。只许官方端点 + 受保护。 */
export function assertSandboxTarget(sb: CodexSandbox, model: string): string {
  const t = codexCallTarget({ model }, { env: { HOME: sb.home, CODEX_HOME: sb.codexHome }, systemDir: null, cwd: sb.workdir })
  const c = classifyCall(t)
  if (!c.protected || c.kind !== 'official') throw new Error(`[reply-once/codex] 目标不是预期的官方端点(${JSON.stringify(c)})—— 拒跑`)
  return `${c.kind} ${c.host ?? ''}`.trim()
}

export interface SandboxFactoryOptions {
  sandbox: CodexSandbox
  /** true:wechat MCP 的工具一律放行(default_tools_approval_mode = approve);false:照生产 strict(不放行、不 bypass)。 */
  approveMcp: boolean
  /** 每一条原始 ThreadEvent(录流用)。 */
  onEvent?: (ev: ThreadEvent) => void
  /** 每次 runStreamed(= 一次真模型回合)。 */
  onRun?: () => void
}

/**
 * 包一层生产的 Codex 构造:env 换成沙盒(HOME / CODEX_HOME),去掉 bypass,MCP 按需放行;thread 一律 read-only + never。
 * provider 其余的事(事件翻译、指令前置、resume、超时)全是生产代码。
 */
export function sandboxCodexFactory(o: SandboxFactoryOptions): CodexFactory {
  return (args) => {
    const a = { ...(args ?? {}) } as Record<string, any>
    const config = { ...(a.config ?? {}) } as Record<string, any>
    delete config.dangerously_bypass_approvals_and_sandbox
    if (config.mcp_servers?.wechat && o.approveMcp) {
      config.mcp_servers = { ...config.mcp_servers, wechat: { ...config.mcp_servers.wechat, default_tools_approval_mode: 'approve' } }
    }
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v
    env.HOME = o.sandbox.home
    env.CODEX_HOME = o.sandbox.codexHome
    delete env.OPENAI_API_KEY
    delete env.CODEX_API_KEY
    const codex = new Codex({ ...a, config, env } as ConstructorParameters<typeof Codex>[0])
    const force = (t?: ThreadOptions): ThreadOptions => ({ ...(t ?? {}), sandboxMode: 'read-only', approvalPolicy: 'never', workingDirectory: o.sandbox.workdir, skipGitRepoCheck: true, networkAccessEnabled: false, webSearchMode: 'disabled' })
    const tee = (thread: Thread): Thread => new Proxy(thread, {
      get(target, prop, recv) {
        if (prop !== 'runStreamed') return Reflect.get(target, prop, recv)
        return async (input: unknown, turnOptions?: unknown) => {
          o.onRun?.()
          const { events } = await (target.runStreamed as (i: unknown, t?: unknown) => Promise<{ events: AsyncGenerator<ThreadEvent> }>).call(target, input, turnOptions)
          async function* gen(): AsyncGenerator<ThreadEvent> { for await (const ev of events) { o.onEvent?.(ev); yield ev } }
          return { events: gen() }
        }
      },
    })
    return {
      startThread: (t?: ThreadOptions) => tee(codex.startThread(force(t))),
      resumeThread: (id: string, t?: ThreadOptions) => tee(codex.resumeThread(id, force(t))),
    } as unknown as Codex
  }
}
