/**
 * OpenAI 兼容执行者(DeepSeek / Kimi / Qwen …)的对话用途 + 一次性评估。
 *
 * 会话本身只有一种(openai-session.ts,架构终态 B2);这里给它配「对话」这一份用途:
 *  - 工具面:MCP(wechat / delegate / 插件,按会话的 mcpEnv 起)+ 内置的 Read / Write / Edit / Bash / view_image;
 *  - 放行:逐个调用过 openai gate(domain/authorize,主人自己的对话先看放行规则);
 *  - 事件:一步的文字攒成一条 text、模型一发起调用就报 tool_call(带真正所属的 server);
 *  - 历史:api-sessions 的对话那张表(`sessions` 给了 DB 那份才续接;不给 ⇒ 内存,不续接)。
 */
import { extractImagePaths, prepareImageParts, appendImageNotes } from './openai-vision'
import {
  type AgentProvider,
  type AgentSession,
  type AgentEvent,
  type AgentMcpTools,
  type AgentProject,
  type SpawnContext,
  assertNotAuthFailed,
} from '../../../ports/agent-provider'
import { isAuthErrorCode, withProviderCode } from '../../../lib/provider-error-code'
import { openaiErrorCode, openaiErrorMessage } from './openai-error-code'
import { systemMessage, userMessage, type APIModel, type ChatMessage, type ToolSpec } from './api-model'
import { builtinTools, type BuiltinTool } from './openai-tools'
import { gateTool } from './openai-gate'
import type { ChatOwnerRules } from '../../permission-rules/chat'
import { makeTurnEmitter } from '../turn-emitter'
import { makeMemoryChatSessionStore, type ApiSessionState, type ChatSession, type ChatSessionBinding, type ChatSessionStore } from './api-sessions'
import { openOpenAiSession, type OpenAiPurpose, type SessionHistory } from './openai-session'

export { OPENAI_CAPABILITIES } from '../../../domain/provider-capabilities'

export interface OpenAiAgentProviderOptions {
  // Builds the model for a given model id (undefined → the provider's configured default). A thunk rather than a single
  // instance so `spawn` can honor `ctx.model` per-session (the operator's pinned model, hot-reloaded via the daemon's
  // mtime-cached config reader — see bootstrap currentModelFor) instead of the model baked in at provider construction.
  // `cheapEval`/`strongEval` are background calls with no per-chat pin, so they pass `evalModel()` (undefined ⇒ the default model).
  makeChatModel: (model?: string) => APIModel
  makeMcpBridge: (mcpEnv: Record<string, string>) => Promise<AgentMcpTools>
  /**
   * 守护(评审 #193 P1-1):`makeChatModel` 实际连的 base URL 和它的默认模型 —— 与建模型用的是**同一份**值(bootstrap
   * 在注册那一刻读的配置)。闸门按它判,不按此刻的 agent-config 判。不给 ⇒ 闸门拿不准 ⇒ 按需要保护。
   */
  endpoint?: { baseUrl: string; model: string }
  /** 后台评估(cheapEval/strongEval)单独用的模型(agent-config `openaiEvalModel`,现取)。不给 / 回空 ⇒ 默认模型。
   *  对话不受影响:主人可以聊天用 Qwen、后台判断用 DeepSeek。 */
  evalModel?: () => string | undefined
  cwd?: string
  maxSteps?: number
  log?: (tag: string, line: string) => void
  /**
   * 测试 / 实验注入口(回复交付 spec §5.1 第 1 项):把 Read/Write/Edit/Bash/view_image 换成别的实现。
   * 生产路径从不传(缺省 = 真的 builtinTools)。
   */
  makeBuiltins?: (cwd: string) => BuiltinTool[]
  /** 主人自己的对话走放行规则(2026-10-25,core/permission-rules/chat.ts)。现取;不给 / 回 null ⇒ 不看规则。 */
  ownerRules?: () => ChatOwnerRules | null
  /** 会话历史存哪(B2):DB 那一份(makeChatSessionStore)⇒ daemon 重启 / 会话释放后续得上。不给 ⇒ 内存,不续接。 */
  sessions?: ChatSessionStore
  /** 绑定续接的连接身份(`openAiConnectionHash`:base URL + 密钥的摘要,不含密钥本身)。换了端点 / 密钥就不续接。 */
  connectionHash?: string
}

const DEFAULT_MAX_STEPS = 25
const CLOSE_TIMEOUT_MS = 4_000
const CANCELLED_TOOL = 'Cancelled: the user stopped this turn before this tool ran.'

/** 存档里不留图(一张就是几 MB,续接时只看得到「这里有过一张图」);在跑的会话照样带着图。 */
function withoutImages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map(m => {
    if (m.role !== 'user' || typeof m.content === 'string' || !m.content.some(p => p.type === 'image' || p.type === 'file')) return m
    return { ...m, content: m.content.map(p => p.type === 'image' || p.type === 'file' ? { type: 'text' as const, text: '[图片:当时看过,存档里不留]' } : p) }
  })
}

/**
 * 对话的历史:内存里那份是准的;存档尽力而为 —— 写不进去就记一行、这条会话以后不再写(也就不会被续接),这一轮照常。
 * (工作台反过来:存不下就是这一轮失败,见 openai-workbench-provider.ts。)
 */
function chatHistory(store: ChatSessionStore, initial: ChatSession, log: (tag: string, line: string) => void): SessionHistory {
  let saved = initial
  let messages = initial.messages
  let state: ApiSessionState = initial.state
  let revision = initial.revision
  let persisting = store.ephemeral !== true
  const stop = (err: unknown) => {
    persisting = false
    log('SESSION_PERSIST', `openai session=${initial.id} 存不下历史,这条会话不再续接:${err instanceof Error ? err.message : String(err)}`)
  }
  return {
    id: initial.id,
    revision: () => revision,
    messages: () => messages,
    state: () => state,
    begin() {
      if (state !== 'ready') return
      state = 'active'; revision++
      if (!persisting) return
      try { saved = store.acquire(saved.id, saved.binding) } catch (err) { stop(err) }
    },
    save(next, nextState = state) {
      messages = next; state = nextState; revision++
      if (!persisting) return
      try { saved = store.save(saved.id, saved.revision, withoutImages(next), nextState) } catch (err) { stop(err) }
    },
  }
}

/**
 * Shared cheapEval/strongEval body: run `model.generate`.
 *  - error-shaped TEXT (Claude/Codex sentinel strings) → assertNotAuthFailed throws on the returned text, as before.
 *  - a THROWN transport error (a real gateway 401 APICallError, a refused connection, our own boundary timeout, …) → the
 *    SAME error is rethrown with a structured `providerErrorCode` attached (openai-error-code), so the registry's
 *    cooldown / llm-health / health classify read the code instead of the text.
 */
async function runEval(model: APIModel, prompt: string, log: (tag: string, line: string) => void, source: string): Promise<string> {
  let text: string
  try {
    text = await model.generate([userMessage(prompt)])
  } catch (err) {
    // 边界产码,挂在抛出物上原样抛(registry 冷却、llm-health、health 都只看码)。401 只说明凭证被拒,
    // 不说明登录过期(红线 A 的细化),码是 auth_rejected。
    const code = openaiErrorCode(err)
    if (isAuthErrorCode(code)) log('AUTH_FAILED', `${source} credentials rejected (${code}): ${openaiErrorMessage(err).slice(0, 160)}`)
    // RetryError(`Failed after 3 attempts. Last error: <none>` 这类)把真实 status 藏在 errors[] 里 —— 换成带 status 的那句。
    if (code && err instanceof Error && Array.isArray((err as { errors?: unknown }).errors)) {
      throw withProviderCode(Object.assign(new Error(openaiErrorMessage(err)), { cause: err }), code)
    }
    throw withProviderCode(err, code)
  }
  assertNotAuthFailed(text, log, source)
  return text
}

/** 对话这一份用途。 */
function chatPurpose(args: {
  ctx: SpawnContext
  bridge: AgentMcpTools
  builtins: BuiltinTool[]
  maxSteps: number
  ownerRules?: () => ChatOwnerRules | null
}): OpenAiPurpose {
  const { ctx, bridge, maxSteps, ownerRules } = args
  const builtinByName = new Map<string, BuiltinTool>(args.builtins.map(b => [b.spec.name, b]))
  const toolSpecs: ToolSpec[] = [...bridge.tools, ...args.builtins.map(b => b.spec)]
  return {
    maxSteps,
    strict: false,
    textEvents: 'per-step',
    singleDispatch: false,
    closeTimeoutMs: CLOSE_TIMEOUT_MS,
    closeMustConfirm: false,
    cancelWaits: false,
    tools: () => toolSpecs,
    // Stamp `server` from the REAL owning MCP server (never assume `wechat` for every MCP tool) — isReplyToolCall keys on it.
    toolCallEvent(call): AgentEvent {
      const server = bridge.serverOf(call.name)
      return { kind: 'tool_call', tool: call.name, ...(server !== undefined ? { server } : {}) }
    },
    async request(text) {
      // 入站图片:提示词里只剩 `[image:path]` 一行,这里整理(超宽缩、超大拒)成 image 分块随用户消息送;
      // 缩过 / 没带上的都在文字里说一句(openai-vision)。
      const prepared = await prepareImageParts(extractImagePaths(text))
      return userMessage(appendImageNotes(text, prepared.notes), prepared.parts)
    },
    async runTool(call, signal) {
      // 一步里多个工具调用:主人 /stop 之后剩下的(可能是有副作用的 Bash)一个都不再跑,但每个 call id 仍要回一条结果,
      // 否则这个会话下一次请求在 API 那边是坏的。
      if (signal.aborted) return { output: CANCELLED_TOOL }
      const server = bridge.serverOf(call.name)
      const input = (call.input ?? {}) as Record<string, unknown>
      const gate = await gateTool({
        toolName: call.name,
        ...(server !== undefined ? { mcpServer: server } : {}),
        input,
        tierProfile: ctx.tierProfile,
        permissionMode: ctx.permissionMode,
        chatId: ctx.chatId,
        ownerRules: ownerRules?.() ?? null,
      })
      if (signal.aborted) return { output: CANCELLED_TOOL }
      if (gate.decision === 'deny') return { output: gate.message ?? `Permission denied: tool "${call.name}" is not allowed for this chat.` }
      try {
        if (server !== undefined) return { output: await bridge.call(call.name, call.input) }
        const builtin = builtinByName.get(call.name)
        if (!builtin) return { output: `Tool error: there is no tool named "${call.name}".` }
        if (builtin.executeRich) {
          // 带图的结果(view_image):文字当工具结果,图另起一条用户消息紧跟这一批之后。
          const rich = await builtin.executeRich(input)
          return { output: rich.text, images: rich.images }
        }
        return { output: await builtin.execute(input) }
      } catch (err) {
        return { output: `Tool error: ${err instanceof Error ? err.message : String(err)}` }
      }
    },
    failure(error, aborted) {
      const em = makeTurnEmitter()
      const reason = error instanceof Error ? error.message : ''
      // /stop:说一句「停了」,这一轮照常收尾(result 照发,历史留着下一轮用)。
      if (aborted || reason === 'api_task_cancelled') return { events: [em.errorText('cancelled', { code: 'cancelled' })], state: 'ready', finish: true }
      if (reason === 'api_task_step_limit') return { events: [em.errorText(`step budget ${maxSteps} exhausted`, { code: 'step_budget' })], state: 'ready', finish: true }
      // 边界产码(arch backlog #4 第 2 步):HTTP status / 重试链里最后一次的 status / 连接层系统码 / 我们自己的超时 ⇒ 码;
      // 消息里把 RetryError 吃掉的真实 status 拼回来。分不出 ⇒ 旧的回退(按文字认 auth)。
      const code = openaiErrorCode(error)
      return { events: [code ? em.errorText(openaiErrorMessage(error), { code }) : em.error(error)], state: 'ready', finish: false }
    },
    close: () => bridge.close(),
  }
}

export function createOpenAiAgentProvider(opts: OpenAiAgentProviderOptions): AgentProvider & { canResume(path: string, sessionId: string): boolean } {
  const log = opts.log ?? (() => {})
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS
  const sessions = opts.sessions ?? makeMemoryChatSessionStore()
  const connection = opts.connectionHash ?? 'unbound'
  const evalModel = (): string | undefined => opts.evalModel?.() || undefined
  const callTarget = (model?: string) => opts.endpoint ? { provider: 'openai', baseUrl: opts.endpoint.baseUrl, model: model ?? opts.endpoint.model } : null

  /** 续接的那条(绑定对得上才续);续不上 ⇒ 记一行、从头来(和续接之前一样),不让这一轮失败。 */
  function openHistory(binding: ChatSessionBinding, initial: ChatMessage[], resumeId: string | undefined): ChatSession {
    if (resumeId) {
      try {
        const found = sessions.acquire(resumeId, binding)
        // 用这一次 spawn 算出的系统提示换掉存下的那条:之后加的规矩 / 档位变化,续接的会话也看得到(和工作台一样,评审 #445)。
        const messages = found.messages[0]?.role === 'system' ? (initial.length ? [initial[0]!, ...found.messages.slice(1)] : found.messages) : [...initial, ...found.messages]
        return messages === found.messages ? found : sessions.save(found.id, found.revision, messages, 'active')
      } catch (err) {
        log('SESSION_RESUME_FAILED', `openai session=${resumeId} 续不上,开新会话:${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return sessions.create(binding, initial)
  }

  return {
    // 会话 / 评估都用 makeChatModel(构造时的 base URL);模型:会话钉的 ?? 默认,评估用 evalModel ?? 默认。
    callTarget: (kind, ctx) => callTarget(kind === 'cheapEval' || kind === 'strongEval' ? evalModel() : ctx?.model),
    canResume: (path, sessionId) => opts.sessions !== undefined && opts.connectionHash !== undefined && sessions.canResume(sessionId, path, connection),
    async spawn(project: AgentProject, ctx: SpawnContext): Promise<AgentSession> {
      const cwd = opts.cwd ?? project.path
      const bridge = await opts.makeMcpBridge(ctx.mcpEnv ?? {})
      // Built once per spawn from ctx.model (the operator's per-chat pinned model, if any) — an in-flight session keeps
      // this model until released, matching the other providers (re-read per spawn, not per turn).
      const model = opts.makeChatModel(ctx.model)
      const target = callTarget(ctx.model)
      const initial = ctx.appendInstructions ? [systemMessage(ctx.appendInstructions)] : []
      const binding: ChatSessionBinding = { chatId: ctx.chatId, alias: project.alias, path: project.path, configHash: connection }
      let saved: ChatSession
      let store = sessions
      try {
        saved = openHistory(binding, initial, ctx.resumeSessionId)
      } catch (err) {
        // DB 出了问题不该让对话起不来:这条会话退回内存(不续接),照常聊。
        log('SESSION_PERSIST', `openai 会话存档不可用,这条会话只在内存里:${err instanceof Error ? err.message : String(err)}`)
        store = makeMemoryChatSessionStore()
        saved = store.create(binding, initial)
      }
      const resumed = ctx.resumeSessionId !== undefined && saved.id === ctx.resumeSessionId
      const session = openOpenAiSession({
        model,
        history: chatHistory(store, saved, log),
        purpose: chatPurpose({ ctx, bridge, builtins: (opts.makeBuiltins ?? builtinTools)(cwd), maxSteps, ...(opts.ownerRules ? { ownerRules: opts.ownerRules } : {}) }),
      })
      log('SESSION_SPAWN', `alias=${project.alias} provider=openai session=${saved.id}${resumed ? ' resumed' : ''}`)
      session.callTarget = () => target
      session.resumedHistory = resumed
      return session
    },

    async cheapEval(prompt: string): Promise<string> {
      // Background eval, no per-chat pin — the eval model if one is configured, else the default model.
      return runEval(opts.makeChatModel(evalModel()), prompt, log, 'openai cheapEval')
    },

    async strongEval(prompt: string): Promise<string> {
      // v1: same model as cheapEval (DeepSeek is already the strong+cheap model).
      return runEval(opts.makeChatModel(evalModel()), prompt, log, 'openai strongEval')
    },
  }
}
