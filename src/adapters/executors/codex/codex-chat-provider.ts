import { tmpdir } from 'node:os'
import { compilePolicy } from '../../../domain/policy'
import { TIER_PROFILES } from '../../../domain/user-tier'
import { mergeEnvIntoMcpServers, CORE_MCP_SERVER_NAMES, type AgentAttachment, type AgentEvent, type AgentProject, type AgentProvider, type AgentSession, type SpawnContext } from '../../../ports/agent-provider'
import type { McpStdioSpec } from '../../../core/mcp-stdio-spec'
import { DELEGATE_TOOL_TIMEOUT_MS, TERMINAL_SAY_TOOL_TIMEOUT_MS } from '../../../core/mcp-stdio-spec'
import { isAuthFail } from '../../../domain/auth-fail'
import { providerErrorCodeOf, withProviderCode } from '../../../lib/provider-error-code'
import { log } from '../../../lib/log'
import { codexCallTarget, type ResolveCodexTargetOptions } from '../../../lib/codex-target'
import { resolveCodexCheapModel } from './codex-cheap-model'
import { codexErrorCode, type CodexTimeouts } from './codex-errors'
import { spawnCodexAppServerSession, type CodexAppServerSession, type CodexChatProfile } from './codex-app-server'
import type { CodexAppServerSpawn } from './codex-app-server-process'

export { CODEX_CAPABILITIES } from '../../../domain/provider-capabilities'
export { codexChatToolCall } from './codex-app-server'

/**
 * Codex 对话侧(微信 / App 的聊天、delegate、首次使用探测、cheapEval)—— 走 `codex app-server`,和工作台同一个
 * 协议客户端(codex-app-server.ts 的 spawnCodexAppServerSession,对话侧的差别见 CodexChatProfile)。
 * B1(主人 2026-10-25 拍板):以前这里是 `@openai/codex-sdk`(每一轮一个 `codex exec`),已删。
 *
 * 一条会话 = 一个常驻 app-server 子进程 + 一个 codex thread:
 *   - 续接:SpawnContext.resumeSessionId ⇒ thread/resume;续接不上(线程没了)⇒ 记一行、起新线程。
 *   - 子进程中途没了(崩溃 / 被杀):下一轮换一个新进程,续接同一个 thread —— 和以前每轮一个 exec 一样不怕上一轮的进程。
 *   - 系统指令走开发者指令槽(developerInstructions),每次起线程 / 续接都带上;不再前置到第一条消息。
 *   - 沙箱 / 审批:compilePolicy('codex') 原样(审批 never,访客 untrusted;codex 发来的审批请求一律拒,见 CodexChatProfile)。
 *   - wechat / delegate / 插件 MCP 作为线程配置;会话令牌与档位只并进核心 MCP 的 env(第三方插件永远拿不到令牌)。
 *   - 中途插话:session.steer(turn/steer)接好了;对话的协调器目前不调它(没有新界面),见 B1 进度行。
 *
 * Auth-agnostic(RFC 03 §3.6 / C7):不收 apiKey。子进程继承 daemon 的环境,主人怎么登录的 codex 就用什么
 * (`codex login` 的 ~/.codex/auth.json,或 OPENAI_API_KEY / CODEX_API_KEY / config.toml)。
 */
export interface CodexChatProviderOptions {
  /** codex 可执行文件;给函数 ⇒ 每次起会话现取(CLI 升级换了路径,下一个会话就用新的)。缺省 PATH 上的 `codex`。 */
  codexPathOverride?: string | (() => string)
  /** 构造时的缺省模型;SpawnContext.model(/model 钉的)优先。都没有 ⇒ codex 自己的缺省。 */
  model?: string
  /** daemon 给的 stdio MCP(wechat / delegate / 插件),每次起会话并进会话 env 后作为线程配置传给 codex。 */
  mcpServers?: Record<string, McpStdioSpec>
  /**
   * daemon 跑在 --dangerously:**这一次** spawn 也是 dangerously 时,MCP 工具调用不问(codex 在审批 never 下
   * 缺省拒掉每一次 MCP 调用:「MCP tool call requires approval, but approval policy is never」)。
   * 访客 / 定时任务被压成 strict 的会话不开(安全 10-20)。
   */
  dangerouslyBypassApprovalsAndSandbox?: boolean
  /** 守护:codex 这一次实际连到哪里(lib/codex-target.ts)。测试注入 env / systemDir,不碰主人的 ~/.codex。 */
  codexTargetOptions?: () => Omit<ResolveCodexTargetOptions, 'cwd' | 'overrides'>
  /** 边界超时;缺省读 WECHAT_CODEX_FIRST_EVENT_TIMEOUT_MS / WECHAT_CODEX_CONNECT_TIMEOUT_MS(见 codex-errors)。 */
  timeouts?: CodexTimeouts
  /** app-server 单个请求的上限(缺省 30s)与关进程的上限(缺省 2s)。测试用。 */
  rpcTimeoutMs?: number
  closeTimeoutMs?: number
  /** 测试接缝:起 app-server 子进程(src/test-support/executors/codex-scripted.ts 的剧本替身)。生产不传。 */
  spawnProcess?: CodexAppServerSpawn
}

/** 这次 spawn 交给 codex 的线程配置:MCP(并好会话 env、放宽超时、dangerously 时免审)+ 档位不给网时关联网搜索。 */
export function codexChatThreadConfig(
  mcpServers: Record<string, McpStdioSpec> | undefined,
  ctx: Pick<SpawnContext, 'mcpEnv' | 'permissionMode' | 'tierProfile'>,
  dangerouslyBypass: boolean,
): Record<string, unknown> {
  const tierOpts = compilePolicy('codex', ctx.tierProfile, ctx.permissionMode)
  const config: Record<string, unknown> = {}
  if (mcpServers && Object.keys(mcpServers).length) {
    const sessionEnv = ctx.mcpEnv ?? {}
    // 只并进 CORE_MCP_SERVER_NAMES(wechat / delegate):第三方插件拿到令牌就能冒充 agent 调回环 API。
    const servers = mergeEnvIntoMcpServers(mcpServers as Record<string, McpStdioSpec & { env?: Record<string, string> }>, sessionEnv, CORE_MCP_SERVER_NAMES) as unknown as Record<string, Record<string, unknown>>
    for (const [name, spec] of Object.entries(servers)) {
      const server: Record<string, unknown> = Object.fromEntries(Object.entries(spec).filter(([, v]) => v !== undefined))
      // codex 每个 MCP 工具调用缺省 60s(tool_timeout_sec):delegate 要一到几分钟。
      if (name === 'delegate') server.tool_timeout_sec = DELEGATE_TOOL_TIMEOUT_MS / 1000
      // terminal_say(2026-10-24)要等终端会话回话到 10 分钟;只能按服务器给 ⇒ 只放宽 admin 会话的 wechat。
      if (name === 'wechat' && sessionEnv.WECHAT_SESSION_TIER === 'admin') server.tool_timeout_sec = TERMINAL_SAY_TOOL_TIMEOUT_MS / 1000
      if (dangerouslyBypass) server.default_tools_approval_mode = 'approve'
      servers[name] = server
    }
    config.mcp_servers = servers
  }
  // 和以前 SDK 的 `--config dangerously_bypass_approvals_and_sandbox=true` 同一个开关(只在这次是 dangerously 时)。
  if (dangerouslyBypass) config.dangerously_bypass_approvals_and_sandbox = true
  if (tierOpts.webSearchEnabled === false) config.web_search = tierOpts.webSearchMode ?? 'disabled'
  return config
}

const errorEvent = (err: unknown): Extract<AgentEvent, { kind: 'error' }> => {
  const message = err instanceof Error ? err.message : String(err)
  const code = providerErrorCodeOf(err) ?? codexErrorCode(message) ?? (isAuthFail('sdk-error', message) ? 'auth_failed' : undefined)
  return { kind: 'error', message, ...(code ? { code } : {}) }
}

export function createCodexChatProvider(opts: CodexChatProviderOptions = {}): AgentProvider {
  const binary = (): string => (typeof opts.codexPathOverride === 'function' ? opts.codexPathOverride() : opts.codexPathOverride) || 'codex'
  // 构造时解析一次:codex login 刷新了模型缓存,daemon 重启后生效。
  const cheapModel = resolveCodexCheapModel()
  const coreOptions = (model: string | undefined) => ({
    codexPathOverride: binary, ...(model ? { model } : {}),
    ...(opts.timeouts ? { timeouts: opts.timeouts } : {}),
    ...(opts.rpcTimeoutMs ? { rpcTimeoutMs: opts.rpcTimeoutMs } : {}),
    ...(opts.closeTimeoutMs ? { closeTimeoutMs: opts.closeTimeoutMs } : {}),
    ...(opts.codexTargetOptions ? { codexTargetOptions: opts.codexTargetOptions } : {}),
    ...(opts.spawnProcess ? { spawnProcess: opts.spawnProcess } : {}),
  })
  // 守护(评审 #193 P1-1 + 2026-10-03):起会话前的预测 —— 按子进程会继承的环境读 codex 自己的配置层
  // (codex 0.153 不认 OPENAI_BASE_URL)。会话起来以后改用 codex 自己 config/read 报的有效配置。
  const targetOf = (model: string | null | undefined, cwd: string | null, overrides?: Record<string, unknown>) =>
    codexCallTarget({ model }, { env: process.env, ...(opts.codexTargetOptions?.() ?? {}), cwd, overrides: overrides ?? null })

  const cheapProfile = (): CodexChatProfile => ({
    // 一次性评估:不给工具、不给网、不给写;`low` 是 codex 在工具目录里带 image_gen 时还肯接的最低推理档。
    sandbox: 'read-only', approvalPolicy: 'never', env: process.env, log,
    config: { web_search: 'disabled', model_reasoning_effort: 'low', sandbox_workspace_write: { network_access: false } },
  })

  return {
    callTarget(kind, ctx) {
      if (kind === 'cheapEval' || kind === 'strongEval') return targetOf(cheapModel ?? null, tmpdir())
      return targetOf(ctx?.model ?? opts.model ?? null, null, opts.dangerouslyBypassApprovalsAndSandbox ? { dangerously_bypass_approvals_and_sandbox: true } : undefined)
    },
    /** 一次 app-server 冷启动 + 一轮(约 3-5s/次),给 20s 余量。 */
    cheapEvalBudgetMs: 20_000,
    async cheapEval(prompt: string): Promise<string> {
      let session: CodexAppServerSession | undefined
      try {
        session = await spawnCodexAppServerSession(coreOptions(cheapModel), { alias: 'codex-cheap-eval', path: tmpdir() }, { tierProfile: TIER_PROFILES.guest, permissionMode: 'strict', chatId: 'codex-cheap-eval' }, cheapProfile())
        const parts: string[] = []
        for await (const ev of session.dispatch(prompt)) {
          if (ev.kind === 'text') parts.push(ev.text)
          else if (ev.kind === 'error') throw withProviderCode(new Error(ev.message), (ev.code as ReturnType<typeof codexErrorCode>) ?? codexErrorCode(ev.message))
        }
        return parts.join('')
      } catch (err) {
        if (providerErrorCodeOf(err)) throw err
        throw withProviderCode(err, codexErrorCode(err instanceof Error ? err.message : String(err)))
      } finally {
        await session?.close().catch(() => {})
      }
    },
    async spawn(project: AgentProject, ctx: SpawnContext): Promise<AgentSession> {
      const tierOpts = compilePolicy('codex', ctx.tierProfile, ctx.permissionMode)
      // 只在**这一次** spawn 是 dangerously 时才免审(安全 10-20)。
      const bypass = !!opts.dangerouslyBypassApprovalsAndSandbox && ctx.permissionMode === 'dangerously'
      const config = codexChatThreadConfig(opts.mcpServers, ctx, bypass)
      const model = ctx.model ?? opts.model
      const profile: CodexChatProfile = { sandbox: tierOpts.sandboxMode, approvalPolicy: tierOpts.approvalPolicy, config, env: process.env, log }
      // 对话只把这几样交给协议客户端;工作台专用的(审批桥、时间线、后台生命周期)一律不带。
      const base: SpawnContext = {
        tierProfile: ctx.tierProfile, permissionMode: ctx.permissionMode, chatId: ctx.chatId,
        ...(ctx.appendInstructions ? { appendInstructions: ctx.appendInstructions } : {}),
        ...(model ? { model } : {}),
      }
      const open = (resumeSessionId?: string) => spawnCodexAppServerSession(coreOptions(opts.model), project, { ...base, ...(resumeSessionId ? { resumeSessionId } : {}) }, profile)
      let core: CodexAppServerSession
      if (ctx.resumeSessionId) {
        try {
          core = await open(ctx.resumeSessionId)
          log('SESSION_RESUME', `alias=${project.alias} thread_id=${ctx.resumeSessionId} provider=codex`)
        } catch (err) {
          // 续接不上(线程文件没了 / 不认):记下来,起一个新线程 —— 不让这个聊天每一轮都卡在同一个坏 id 上。
          // 起新线程也失败 ⇒ 那是 codex 本身的问题(登录、配置),原样抛给会话管理。
          log('SESSION_RESUME_FAILED', `alias=${project.alias} thread_id=${ctx.resumeSessionId} provider=codex — ${err instanceof Error ? err.message.slice(0, 200) : String(err)}; starting a new thread`)
          core = await open()
        }
      } else core = await open()
      let lastThreadId = core.threadId()
      log('SESSION_INIT', `alias=${project.alias} thread_id=${lastThreadId} provider=codex`)
      let closed = false

      return {
        callTarget: () => core.callTarget?.() ?? targetOf(model ?? null, project.path, config),
        dispatch(text: string, attachments?: readonly AgentAttachment[]): AsyncIterable<AgentEvent> {
          return {
            async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
              if (closed) return
              let events: AsyncIterable<AgentEvent>
              try {
                if (!core.alive()) {
                  // 上一个 app-server 没了:换新进程,续接同一个 thread。
                  log('SESSION_RESPAWN', `alias=${project.alias} thread_id=${lastThreadId} provider=codex`)
                  await core.close().catch(() => {})
                  if (closed) return
                  core = await open(lastThreadId || undefined)
                  lastThreadId = core.threadId()
                }
                events = core.dispatch(text, attachments)
              } catch (err) {
                // 起不来 / 上一轮还没收尾:带码的 error 事件收尾,别抛 —— 抛出去协调器拿不到 summary。
                const ev = errorEvent(err)
                log('SESSION_ERROR', `alias=${project.alias} provider=codex dispatch: ${ev.message.slice(0, 300)}`)
                yield ev
                return
              }
              for await (const ev of events) {
                if (ev.kind === 'init' && ev.sessionId) lastThreadId = ev.sessionId
                yield ev
              }
            },
          }
        },
        async steer(text: string, attachments?: readonly AgentAttachment[]): Promise<void> {
          if (closed || !core.alive() || !core.steer) throw new Error('codex_no_active_turn')
          await core.steer(text, attachments)
        },
        async cancel(): Promise<void> {
          if (closed) return
          // 中断这一轮,会话留着:之后的 dispatch 照常。
          await core.cancel?.().catch(() => {})
        },
        async close(): Promise<void> {
          closed = true
          await core.close()
        },
      }
    },
  }
}
