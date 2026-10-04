#!/usr/bin/env bun
/**
 * EXPERIMENT ONLY — reply-once harness(2026-10-02)。不接进 daemon,daemon 也不 import 它。
 *
 * 问题:openai provider 自己的工具循环里,「一轮结束」唯一的方式是某一步不调任何工具。
 * 真机上 Qwen3.8 一轮里连发 reply(2→4→5 条,还有「（真的停了）」);#186 在 reply 回执里
 * 补了一句收手提示,结果模型反而把 list_projects/add_project/… 一路调到预算用完(#189 撤回)。
 * 这个 harness 用**真模型**(主人自建网关上的 Qwen3.8)+ **假工具**跑真循环,量化各候选修法。
 *
 * 隔离:
 *  - 循环:就是 src/core/openai-agent-provider.ts 的 createOpenAiAgentProvider,进程内跑。
 *  - wechat 工具:真的 wechat MCP 工具注册代码(同一份 schema / 描述),但接在进程内
 *    InMemoryTransport 上、背后是一个只记账的假 InternalApiClient —— 不连 daemon,不发微信,
 *    不读写 projects.json。
 *  - 内置工具(Read/Write/Edit/Bash/view_image):只有 spec 是真的,execute 只记账、绝不执行。
 *  - 状态目录:临时目录;不读主人的对话、记忆、会话。
 *  - 只读两处配置:agent-config.json 的 openaiBaseUrl/openaiModel、daemon.env 的
 *    WECHAT_OPENAI_API_KEY(不打印)。也可以用环境变量 WECHAT_OPENAI_API_KEY / REPLY_ONCE_BASE_URL /
 *    REPLY_ONCE_MODEL 覆盖。
 *
 * 用法:
 *   bun scripts/experiments/reply-once/harness.ts --arm baseline --scenarios a,b,c,d --runs 5 --out /tmp/x.jsonl
 *   bun scripts/experiments/reply-once/harness.ts --summarize /tmp/x.jsonl
 *   bun scripts/experiments/reply-once/harness.ts --gate /tmp/x.jsonl      # 回复交付 spec §5.8 的过关线(daemon vs baseline)
 *
 * 场景(2026-10-03 起 a–i,回复交付 spec §5.8):
 *   a 一句简短的话 / b 历史里有连发 + 「停」/ c 分三条 / d 我有哪些项目 / e 新会话连跑四轮
 *   f 用语音说晚安 / g 伙伴推送 + 议程已过期(该静默)/ h 要 3–4 次工具的查询 / i 私聊里「不用回」
 *
 * 候选(--arm):
 *   baseline     现在的 dev
 *   i_plain_ack  reply 成功回执换成纯文字「delivered」(不带任何邀请)
 *   ii_prompt    系统提示里写清楚一轮怎么结束(不在工具回执里加东西)
 *   iii_drop     循环侧:本轮已有成功 reply 后,下一步若只是 reply 且内容是元话语/近似重复 ⇒ 丢掉并结束
 *   iv_restrict  循环侧:成功 reply 之后的下一步只给 reply 族工具(可以再发,也可以不调 = 结束)
 *   v_condense   历史侧:之前几轮里的多条 reply 合并成一条再给模型看
 *   shipped      提交进 provider 的正式实现(不靠 harness 包装)
 *   daemon       回复交付第 1 步(spec 2026-10-03):没有 reply 族工具,最后写下的文字就是回复,经真的
 *                deliverTurnReply(假的 sendText)送达;附件工具 / admin 的 message;final_text 版提示词
 *   agy_legacy / agy_daemon  回复交付第 2 步:**真 agy**(连 Google,每轮前查 bx),沙盒工作区 + 假 internal API,
 *                见 agy-sandbox.ts。先 --agy-init <目录> 建 agy 项目,再 --agy-ws <目录> --agy-project <id>。
 *   cursor_legacy / cursor_daemon  回复交付第 3 步:**不连模型**。照真机报文形状演的假 cursor-agent acp + 生产的
 *                ACP 客户端 / 协调器 / 交付运行时,见 cursor-fixture.ts。--arm cursor 一次跑两臂:
 *                bun scripts/experiments/reply-once/harness.ts --arm cursor --out x.jsonl
 *                bun scripts/experiments/reply-once/harness.ts --gate x.jsonl --gate-arms cursor_daemon,cursor_legacy
 *   codex_legacy / codex_daemon  回复交付第 4 步的剧本臂:**不连模型**。照 codex exec 事件形状演的假 Codex + 生产的
 *                Codex provider / 协调器 / 交付运行时,见 codex-fixture.ts。--arm codex 一次跑两臂。
 *   codex_real_legacy / codex_real_daemon  第 4 步的真模型小批:**真 codex + api.openai.com**(每轮前查 bx),沙盒
 *                CODEX_HOME(只复制登录)+ 假 internal API,见 codex-sandbox.ts。必须给 --budget;--strict 不放行 MCP
 *                (照生产 strict 看 codex 怎么拒);--codex-raw <jsonl> 录原始事件流。
 *   claude_legacy / claude_daemon  回复交付第 5 步的剧本臂:**不连模型**。照 Agent SDK 消息形状演的假 query() + 生产的
 *                Claude provider / 协调器 / 交付运行时,见 claude-fixture.ts。--arm claude 一次跑两臂。
 *   claude_real_legacy / claude_real_daemon  第 5 步的真模型小批:**真 Claude Code + api.anthropic.com**(每轮前查 bx),
 *                沙盒 HOME(登录只读、只经环境变量给 access token,不给 refresh token)+ 假 internal API,见
 *                claude-sandbox.ts。必须给 --budget;--claude-raw <jsonl> 录原始 SDK 消息。
 */
// 隔离护栏必须第一个求值(见 isolate.ts:STATE_DIR 在 import 期就被定下来了)。
import { STATE_DIR } from './isolate'
import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { InternalApiClient } from '../../../src/mcp-servers/wechat/client'
import { registerMemoryTools } from '../../../src/mcp-servers/wechat/tools-memory'
import { registerProjectTools } from '../../../src/mcp-servers/wechat/tools-projects'
import { registerVoiceShareTools } from '../../../src/mcp-servers/wechat/tools-voice-share'
import { registerMessagingTools } from '../../../src/mcp-servers/wechat/tools-messaging'
import { registerCompanionTools } from '../../../src/mcp-servers/wechat/tools-companion'
import { registerA2ASendTool } from '../../../src/mcp-servers/wechat/tools-a2a'
import { registerModeTools } from '../../../src/mcp-servers/wechat/tools-mode'
import { registerDaemonTools } from '../../../src/mcp-servers/wechat/tools-daemon'
import { registerFileTools } from '../../../src/mcp-servers/wechat/tools-files'
import { registerConfigTools } from '../../../src/mcp-servers/wechat/tools-config'
import { registerTurnTools } from '../../../src/mcp-servers/wechat/tools-turn'
import { makeReplyDeliveryRuntime, type ReplyDeliveryRuntime } from '../../../src/daemon/reply-delivery'
import { createOpenAiAgentProvider, type OpenAiAgentProviderOptions } from '../../../src/core/openai-agent-provider'
import { createAgyAgentProvider, DEFAULT_AGY_MODEL } from '../../../src/core/agy-agent-provider'
import { assertBxProtected, createAgyProject, sandboxMcpEnv, sandboxSpawnFn, startFakeInternalApi, writeAgySandboxWorkspace, WECHAT_MCP_MAIN } from './agy-sandbox'
import { byVariant, runCursorGate, CURSOR_SCENARIOS, type CursorArm } from './cursor-fixture'
import { byVariant as codexByVariant, runCodexFixtureGate, CODEX_SCENARIOS, type CodexArm } from './codex-fixture'
import { makeCodexSandbox, assertSandboxTarget, sandboxCodexFactory } from './codex-sandbox'
import { createCodexAgentProvider } from '../../../src/core/codex-agent-provider'
import { byVariant as claudeByVariant, runClaudeFixtureGate, CLAUDE_SCENARIOS, type ClaudeArm } from './claude-fixture'
import { makeClaudeSandbox, assertSandboxTarget as assertClaudeTarget, assertKeychainUntouched, sandboxCanUseTool, sandboxSdkOptions, teeQuery } from './claude-sandbox'
import { createClaudeAgentProvider, DEFAULT_CLAUDE_MODEL } from '../../../src/core/claude-agent-provider'
import { isReplyToolCall } from '../../../src/core/agent-provider'
import { createAiSdkChatModel, type ChatModelClient, type ChatMessage, type StreamedTurn, type ToolSpec, type TurnDelta } from '../../../src/core/openai-chat-model'
import { createMcpToolBridge, type McpClientLike } from '../../../src/core/openai-mcp-bridge'
import { builtinTools, type BuiltinTool } from '../../../src/core/openai-tools'
import { buildSystemPrompt, bubbleRepliesSection } from '../../../src/core/prompt-builder'
import { formatInbound } from '../../../src/core/prompt-format'
import { buildColdStartBlock, type HandoffTurn } from '../../../src/core/provider-handoff'
import { TIER_PROFILES } from '../../../src/core/user-tier'
import type { AgentEvent } from '../../../src/core/agent-provider'
import { extractTurnReply, parseSilence, type ReplyTextStrategy } from '../../../src/core/turn-reply'
import { replyTextStrategyFor } from '../../../src/core/capability-matrix'
import { buildPushTickText } from '../../../src/daemon/wiring/tick-bodies'
import { summarize, evaluateGate, formatGate, doubleSends, META_RE, REPLY_FAMILY, SPEAKING_TOOLS, type Arm, type Scenario, type RunResult } from './gate'
export { summarize, evaluateGate, type Arm, type Scenario, type RunResult }

// ─── 隔离护栏:见 isolate.ts(STATE_DIR 是临时目录,第一个 import 就设好)───────────

const CHAT_ID = 'o9demo_owner@im.wechat'
const HARNESS_MAX_STEPS = 12 // 生产是 25;这里够看出失控,又不烧网关
/** g:议程里一条早就过了具体时刻的跟进(一个多月前那晚的直播)—— 按推送提示应当不发。 */
const G_NOW_ISO = '2026-10-03T10:00:00+08:00'
const G_INTENTION = '8 月 20 日晚上 8 点提醒他看那场发布会直播'

const SCENARIO_PROMPT: Record<Scenario, string> = {
  a: 'e2e 测试:回我一句简短的话就行。',
  b: 'e2e 测试:回我一句简短的话就行。',
  b_guarded_seed: 'e2e 测试:回我一句简短的话就行。',
  b_cold: 'e2e 测试:回我一句简短的话就行。',
  c: '分三条消息发给我三个周末放松的建议,每条一个。',
  d: '我现在有哪些项目?',
  // e:同一个新会话里真跑四轮(前三轮是 SEED_TURNS 的用户话,模型自己回),看会不会一轮比一轮多。
  e: 'e2e 测试:回我一句简短的话就行。',
  f: '用语音跟我说句晚安吧。',
  g: '', // 伙伴推送:提示由 buildPushTickText 生成(见 promptFor)
  h: '帮我看看我现在有哪些项目,再翻翻你记忆里关于我的 profile,然后告诉我最近应该先推进哪一个。',
  i: '不用回我了,我就是随便发发。',
}

/** g 是伙伴推送那一种场合(NO_REPLY 只在这类场合被认可);其余都是私聊。 */
const contextOf = (sc: Scenario): 'dm' | 'tick' => sc === 'g' ? 'tick' : 'dm'

// 真机那次的升级过程:同一会话里一轮比一轮多发,还用 reply 发「停」。
const SEED_TURNS: { user: string; replies: string[] }[] = [
  { user: '在吗', replies: ['在的,怎么了?', '有什么需要我帮忙的吗'] },
  { user: '测试一下,回一句就行', replies: ['收到 👍', '测试正常', '抱歉刚才多发了一条', '（停，不再发了 😅）'] },
  { user: '再测一次,只回一句', replies: ['收到', '这次只回一句', '嗯……又多了', '（停，不再发了 😅）', '（真的停了）'] },
]

// ─── provider 注入口(2026-10-03 说明)────────────────────────────────────
// 这个 harness 是从关掉的 PR #196 原样搬来的。它要求 provider 有两个只给实验用的选项:
//   makeBuiltins   —— 把 Read/Write/Edit/Bash/view_image 换成只记账的假工具(安全前提);
//   replyTailGuard —— PR #196 的尾巴守卫开关(只有 arm=shipped 用)。
// dev 上的 provider 目前**没有**这两个选项(#196 没合;reply-delivery 设计
// docs/superpowers/specs/2026-10-03-reply-delivery-design.md §9 第 0 步才把 makeBuiltins 加回来)。
// 没有 makeBuiltins 时,模型调的 Bash 会被真的执行 —— 所以下面的 assertProviderSeams 直接拒跑。
type HarnessProviderOptions = OpenAiAgentProviderOptions & {
  makeBuiltins?: (cwd: string) => BuiltinTool[]
  replyTailGuard?: boolean | (() => boolean)
}

export function assertProviderSeams(arm: Arm, providerSource: string = createOpenAiAgentProvider.toString()): void {
  if (!providerSource.includes('makeBuiltins')) {
    throw new Error('[reply-once] provider 没有 makeBuiltins 注入口:内置工具会被真的执行,拒跑。见 harness 顶部「provider 注入口」说明。')
  }
  if (arm === 'shipped' && !providerSource.includes('replyTailGuard')) {
    throw new Error('[reply-once] arm=shipped 需要 PR #196 的 replyTailGuard(未合入 dev),拒跑。')
  }
}

// ─── 记账 ────────────────────────────────────────────────────────────────
interface Ledger {
  replies: string[]; texts: string[]; voices: string[]; tools: string[]; modelCalls: number; dropped: string[]
  /** daemon 臂:经 deliverTurnReply 真正发出的每一条文字 / 附件种类 / message / 交付日志的 tag。 */
  delivered: string[]; attachments: string[]; messages: string[]; logs: string[]
  /** 假 internal API 收到的每个请求路径(agy 臂:证明 MCP 调用真的到了我们的假 API,不是别处)。 */
  api: string[]
}
const newLedger = (): Ledger => ({ replies: [], texts: [], voices: [], tools: [], modelCalls: 0, dropped: [], delivered: [], attachments: [], messages: [], logs: [], api: [] })

/** daemon 臂的交付运行时:真的 reply-delivery,假的 sendText(只记账)。 */
function fakeDeliveryRuntime(ledger: () => Ledger): ReplyDeliveryRuntime {
  let n = 0
  return makeReplyDeliveryRuntime({
    sendText: async (_c, t) => { ledger().delivered.push(t); return { msgId: `sent:${++n}` } },
    sleep: async () => {},
    log: (tag) => { ledger().logs.push(tag) },
  })
}

function fakeInternalApi(ledger: () => Ledger, rt?: () => ReplyDeliveryRuntime, opts: { sharedTokenProvider?: string } = {}): InternalApiClient {
  let n = 0
  return {
    async request<T>(_method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
      const b = (body ?? {}) as Record<string, unknown>
      ledger().api.push(path.split('?')[0]!)
      if (path === '/v1/turn/attach' && rt) {
        // 共享令牌(agy-static):和生产一样,按「这家 provider 此刻正在跑的那一轮」认聊天。
        let chat: string | undefined = CHAT_ID
        if (opts.sharedTokenProvider) {
          const bnd = rt().turnChatFor(opts.sharedTokenProvider)
          if (bnd.kind === 'ambiguous') return { ok: false, error: 'ambiguous_turn' } as T
          chat = bnd.kind === 'bound' ? bnd.chatId : undefined
          if (!chat) return { ok: false, error: 'no_turn_in_progress' } as T
        }
        const kind = String(b.kind ?? '')
        const attachment = kind === 'voice' ? { kind: 'voice' as const, text: String(b.text ?? '') }
          : kind === 'file' ? { kind: 'file' as const, path: String(b.path ?? '') }
          : { kind: 'sticker' as const, ref: { tag: String(b.tag ?? b.mood ?? '') } }
        const ok = rt().attach(chat, { attachment, send: async () => { ledger().attachments.push(kind); return { ok: true } } })
        return (ok ? { ok: true, attached: true } : { ok: false, error: 'no_turn_in_progress' }) as T
      }
      if (path.startsWith('/v1/health')) return { ok: true, daemon_pid: 0 } as T
      if (path === '/v1/wechat/message') {
        ledger().messages.push(String(b.text ?? ''))
        return (b.to === 'owner' || b.to === CHAT_ID ? { ok: false, error: 'message_to_own_chat' } : { ok: true, msg_id: `m:${++n}` }) as T
      }
      if (path === '/v1/wechat/reply' || path === '/v1/wechat/reply_voice') {
        // 2026-10-02 的口径:replies 里 reply 与 reply_voice 都算;voices 另记一份给新指标。
        ledger().replies.push(String(b.text ?? ''))
        if (path === '/v1/wechat/reply_voice') ledger().voices.push(String(b.text ?? ''))
        else ledger().texts.push(String(b.text ?? ''))
        return { ok: true, msg_id: `sent:${++n}` } as T
      }
      // h:有一份假的 profile 可读(只在内存里,不碰主人的记忆)。
      if (path.startsWith('/v1/memory/list')) return { files: [`${CHAT_ID}/profile.md`] } as T
      if (path === '/v1/memory/read') {
        return (String(b.path ?? '').endsWith('profile.md')
          ? { exists: true, content: '他最近在赶 wechat-cc 的回复交付重构,很在意这周能不能合进 dev;blog 已经停更两个月了。' }
          : { exists: false }) as T
      }
      if (path === '/v1/projects/list') {
        return [
          { alias: 'wechat-cc', path: '/Users/demo/code/wechat-cc', current: true },
          { alias: 'blog', path: '/Users/demo/code/blog', current: false },
        ] as T
      }
      return { ok: true } as T
    },
  }
}

async function fakeWechatMcpClient(ledger: () => Ledger, rt?: () => ReplyDeliveryRuntime): Promise<McpClientLike> {
  const api = fakeInternalApi(ledger, rt)
  const server = new McpServer({ name: 'wechat-mcp-fake', version: '0.0.0' }, { capabilities: { tools: {} } })
  registerMemoryTools(server, api)
  registerProjectTools(server, api)
  registerVoiceShareTools(server, api)
  // daemon 臂:和生产里 WECHAT_REPLY_DELIVERY=daemon 时同一份注册(没有 reply 族,换成附件 + admin 的 message)。
  registerMessagingTools(server, api, { replyDelivery: rt ? 'daemon' : 'tool' })
  if (rt) registerTurnTools(server, api, { admin: true })
  registerCompanionTools(server, api)
  registerA2ASendTool(server, api)
  registerModeTools(server, api)
  registerDaemonTools(server, api)
  registerFileTools(server, api)
  registerConfigTools(server, api)
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(a)
  const client = new Client({ name: 'reply-once-harness', version: '0.0.0' }, { capabilities: {} })
  await client.connect(b)
  return client as unknown as McpClientLike
}

function fakeBuiltins(ledger: () => Ledger) {
  return (cwd: string): BuiltinTool[] => builtinTools(cwd).map(b => ({
    spec: b.spec,
    risk: b.risk,
    async execute() { ledger().tools.push(b.spec.name); return `(实验环境:${b.spec.name} 未执行)` },
  }))
}

// ─── 候选包装 ─────────────────────────────────────────────────────────────

function partsOf(m: ChatMessage): any[] { return Array.isArray((m as any).content) ? (m as any).content : [] }

function lastUserIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) if ((messages[i] as any).role === 'user') return i
  return -1
}

/** 本轮(最后一条 user 之后)已发出的 reply 文本。 */
function repliesThisTurn(messages: ChatMessage[]): string[] {
  const out: string[] = []
  for (const m of messages.slice(lastUserIndex(messages) + 1)) {
    if ((m as any).role !== 'assistant') continue
    for (const p of partsOf(m)) if (p.type === 'tool-call' && REPLY_FAMILY.has(p.toolName)) out.push(String(p.input?.text ?? ''))
  }
  return out
}

function lastStepWasSuccessfulReply(messages: ChatMessage[]): boolean {
  const last = messages[messages.length - 1] as any
  if (!last || last.role !== 'tool') return false
  return partsOf(last).some(p => p.type === 'tool-result' && REPLY_FAMILY.has(p.toolName) && /"ok":true|delivered/.test(String(p.output?.value ?? '')))
}

const norm = (s: string) => s.replace(/[\s\p{P}\p{S}]/gu, '')
function isMetaOrDup(text: string, prior: string[]): boolean {
  if (META_RE.test(text)) return true
  const t = norm(text)
  return t.length === 0 || prior.some(p => { const q = norm(p); return q.length > 0 && (q === t || q.includes(t) || t.includes(q)) })
}

/** iii:先把这一步收完,再决定要不要丢。 */
function dropMetaStep(turn: StreamedTurn, prior: string[], ledger: Ledger): StreamedTurn {
  const buffered: TurnDelta[] = []
  let decided: Awaited<StreamedTurn['finished']> | null = null
  const finishedP = (async () => {
    for await (const d of turn.deltas) buffered.push(d)
    const f = await turn.finished
    const calls = f.toolCalls
    const drop = prior.length > 0 && calls.length > 0
      && calls.every(c => REPLY_FAMILY.has(c.name) && isMetaOrDup(String((c.input as any)?.text ?? ''), prior))
    if (drop) { for (const c of calls) ledger.dropped.push(String((c.input as any)?.text ?? '')); decided = { messages: [], toolCalls: [] } } else decided = f
    return decided
  })()
  return {
    deltas: (async function* () {
      const f = await finishedP
      for (const d of buffered) if (d.kind === 'text' || f.toolCalls.length > 0) yield d
    })(),
    finished: finishedP,
  }
}

/** v:之前几轮的多条 reply 合成一条(内容不丢,只是不再给模型「一轮发五条」的样板)。 */
function condensePriorBursts(messages: ChatMessage[]): ChatMessage[] {
  const cut = lastUserIndex(messages)
  const out: ChatMessage[] = []
  let i = 0
  while (i < cut) {
    const m = messages[i] as any
    out.push(m); i++
    if (m.role !== 'user') continue
    // 收集这一轮(到下一条 user 或 cut)
    let j = i
    while (j < cut && (messages[j] as any).role !== 'user') j++
    const seg = messages.slice(i, j) as any[]
    const onlyReplies = seg.length > 0 && seg.every(s =>
      (s.role === 'assistant' && partsOf(s).every((p: any) => (p.type === 'tool-call' && REPLY_FAMILY.has(p.toolName)) || (p.type === 'text' && !String(p.text).trim()) || p.type === 'reasoning'))
      || (s.role === 'tool' && partsOf(s).every((p: any) => REPLY_FAMILY.has(p.toolName))))
    const calls = seg.flatMap(s => s.role === 'assistant' ? partsOf(s).filter((p: any) => p.type === 'tool-call') : [])
    if (onlyReplies && calls.length > 1) {
      const first = calls[0]
      const text = calls.map((c: any) => String(c.input?.text ?? '')).filter((t: string) => !META_RE.test(t)).join('\n')
      out.push({ role: 'assistant', content: [{ ...first, input: { ...first.input, text } }] } as any)
      const res = seg.find(s => s.role === 'tool')
      const firstRes = partsOf(res).find((p: any) => p.toolCallId === first.toolCallId) ?? partsOf(res)[0]
      out.push({ role: 'tool', content: [firstRes] } as any)
    } else out.push(...seg)
    i = j
  }
  return [...out, ...messages.slice(cut)]
}

export const II_PROMPT_LINE = '一轮怎么结束:要说的话用 reply 发完,下一步就**什么工具都不调、也不输出文字**——这就是结束,不需要任何收尾动作。不要发「停了」「不再发了」「抱歉多发了」这类收尾消息;上文里如果你曾经多发过,别照着学。'

interface Harness { model: ChatModelClient; state: { script: string[] | null; lastCalls: string[] } }

function wrapModel(real: ChatModelClient, arm: Arm, ledger: () => Ledger): Harness {
  const state = { script: null as string[] | null, lastCalls: [] as string[] }
  const model: ChatModelClient = {
    ...real,
    streamTurn(messages: ChatMessage[], tools: ToolSpec[]): StreamedTurn {
      if (state.script) return arm === 'daemon' ? scriptedTextStep(state.script) : scriptedStep(state.script)
      ledger().modelCalls++
      let msgs = messages
      let ts = tools
      if (arm === 'v_condense') msgs = condensePriorBursts(messages)
      if (arm === 'iv_restrict' && lastStepWasSuccessfulReply(messages)) ts = tools.filter(t => REPLY_FAMILY.has(t.name))
      const turn = real.streamTurn(msgs, ts)
      void turn.finished.then(f => { state.lastCalls = f.toolCalls.map(c => String((c.input as any)?.text ?? c.name)) }, () => {})
      if (arm === 'iii_drop') return dropMetaStep(turn, repliesThisTurn(messages), ledger())
      return turn
    },
  }
  return { model, state }
}

/** daemon 臂的灌历史:迁移后历史里是助理**文字**形状的连发(一条消息,段间空行),不是 reply 调用。 */
function scriptedTextStep(queue: string[]): StreamedTurn {
  const text = queue.splice(0).join('\n\n')
  if (!text) return { deltas: (async function* () {})(), finished: Promise.resolve({ messages: [], toolCalls: [] }) }
  return {
    deltas: (async function* () { yield { kind: 'text' as const, text } })(),
    finished: Promise.resolve({ messages: [{ role: 'assistant', content: [{ type: 'text', text }] } as ChatMessage], toolCalls: [] }),
  }
}

function scriptedStep(queue: string[]): StreamedTurn {
  const text = queue.shift()
  if (text === undefined) return { deltas: (async function* () {})(), finished: Promise.resolve({ messages: [], toolCalls: [] }) }
  const id = `seed_${randomUUID().slice(0, 8)}`
  const input = { chat_id: CHAT_ID, text }
  return {
    deltas: (async function* () { yield { kind: 'tool_call' as const, id, name: 'reply', input } })(),
    finished: Promise.resolve({
      messages: [{ role: 'assistant', content: [{ type: 'tool-call', toolCallId: id, toolName: 'reply', input }] } as ChatMessage],
      toolCalls: [{ id, name: 'reply', input }],
    }),
  }
}

// ─── 配置 ────────────────────────────────────────────────────────────────
function gatewayConfig(): { baseURL: string; model: string; apiKey: string } {
  const dir = join(homedir(), '.claude/channels/wechat')
  const cfg = existsSync(join(dir, 'agent-config.json')) ? JSON.parse(readFileSync(join(dir, 'agent-config.json'), 'utf8')) : {}
  let apiKey = process.env.WECHAT_OPENAI_API_KEY
  if (!apiKey && existsSync(join(dir, 'daemon.env'))) {
    const m = /^\s*(?:export\s+)?WECHAT_OPENAI_API_KEY=(.*)$/m.exec(readFileSync(join(dir, 'daemon.env'), 'utf8'))
    apiKey = m?.[1]?.trim().replace(/^["']|["']$/g, '')
  }
  const baseURL = process.env.REPLY_ONCE_BASE_URL ?? cfg.openaiBaseUrl
  const model = process.env.REPLY_ONCE_MODEL ?? cfg.openaiModel
  if (!apiKey || !baseURL || !model) throw new Error('need WECHAT_OPENAI_API_KEY + openaiBaseUrl + openaiModel')
  return { baseURL, model, apiKey }
}

function systemPrompt(arm: Arm, model: string): string {
  const p = buildSystemPrompt({
    providerId: 'openai', model, peerProviderId: 'claude', companionEnabled: false, delegateAvailable: false,
    daemonOpsAvailable: true, fileLocateAvailable: true, bubbleReplies: true,
    ...(arm === 'daemon' ? { replyDelivery: 'final_text' as const, replyText: replyTextStrategyFor('openai'), messageToolAvailable: true } : {}),
  })
  if (arm !== 'ii_prompt') return p
  const bubble = bubbleRepliesSection()
  return p.replace(bubble, `${bubble}\n\n${II_PROMPT_LINE}`)
}

/**
 * 只许打主人自建、没有封号风险的网关(2026-10-03 的约定:llm.youdamaster.cc 上的 Qwen3.8)。
 * 直连供应商会封号 —— harness 不过 daemon 的网络守护,所以在这里按主机名硬拦。
 */
export const ALLOWED_GATEWAY_HOSTS = (process.env.REPLY_ONCE_ALLOWED_HOSTS ?? 'llm.youdamaster.cc').split(',').map(h => h.trim()).filter(Boolean)
export function assertGatewayHost(baseURL: string, allowed: readonly string[] = ALLOWED_GATEWAY_HOSTS): void {
  let host: string
  try { host = new URL(baseURL).hostname } catch { throw new Error(`[reply-once] base URL 不是合法 URL:${baseURL}`) }
  if (!allowed.includes(host)) throw new Error(`[reply-once] 只许打 ${allowed.join(' / ')},这次是 ${host} —— 拒跑(直连供应商会封号)。`)
}

/** 这一轮的提示:g 是伙伴推送(议程已过期),其余是主人的一句话。 */
function promptFor(scenario: Scenario, arm: Arm): string {
  if (scenario === 'g') return buildPushTickText({ nowIso: G_NOW_ISO, defaultChatId: CHAT_ID, intention: G_INTENTION }, { replyDelivery: arm === 'daemon' ? 'final_text' : 'tool', allSegments: arm === 'daemon' && replyTextStrategyFor('openai') === 'all_segments' })
  return inbound(SCENARIO_PROMPT[scenario])
}

/** daemon 臂一轮主人收到了什么:就是 deliverTurnReply 真发出去的那些。 */
export function measureDaemon(
  evs: AgentEvent[],
  ledger: { delivered: string[]; attachments: string[]; logs: string[] },
  parts: { finalText: string; narration: string[] } | undefined,
  report: { delivery: string } | undefined,
  context: 'dm' | 'tick',
  strategy: ReplyTextStrategy = replyTextStrategyFor('openai'),
): Pick<RunResult, 'delivered' | 'attachments' | 'narrationLeaked' | 'tokenLeaked' | 'silent' | 'silentInDm' | 'budgetExhausted' | 'context' | 'finalText' | 'textStrategy' | 'segmentsLost'> {
  const err = evs.find(e => e.kind === 'error') as Extract<AgentEvent, { kind: 'error' }> | undefined
  const delivered = [...ledger.delivered]
  // 旁白与最后的话一字不差(模型调工具前后说了同一句)不算外泄 —— 只发出去一次。
  const final = (parts?.finalText ?? '').trim()
  const narration = (parts?.narration ?? []).map(n => n.trim()).filter(n => n.length >= 4 && n !== final)
  return {
    delivered,
    attachments: [...ledger.attachments],
    narrationLeaked: narration.filter(n => delivered.some(d => d.includes(n))).length,
    tokenLeaked: delivered.some(t => /NO_REPLY/i.test(t)),
    silent: report?.delivery === 'silent',
    silentInDm: ledger.logs.includes('REPLY_SILENT_IN_DM'),
    budgetExhausted: err?.code === 'step_budget',
    context,
    finalText: (parts?.finalText ?? '').slice(0, 300),
    textStrategy: strategy,
    // 聊天型:模型写下的每一段(去掉令牌)都该送到;静默的轮不算丢。编码型不量(旁白本来就不发)。
    ...(strategy === 'all_segments' ? { segmentsLost: report?.delivery === 'silent' ? 0 : lostSegments(parts, delivered) } : {}),
  }
}

const normText = (t: string) => t.replace(/[\s\p{P}\p{S}]/gu, '')
function lostSegments(parts: { finalText: string; narration: string[] } | undefined, delivered: string[]): number {
  if (!parts) return 0
  const sent = normText(delivered.join(''))
  return [...parts.narration, parts.finalText]
    .map(t => normText(parseSilence(t).text))
    .filter(t => t.length > 0 && !sent.includes(t)).length
}

/**
 * legacy 一轮「主人到底收到了什么」:私聊里调过 reply ⇒ 只有 reply 的文字;没调 ⇒ FALLBACK_REPLY 把
 * 每段文字各发一条(旁白也在里面)。伙伴推送只认 reply 工具,文字全丢(tick-bodies 的旧行为)。
 */
export function measureLegacy(evs: AgentEvent[], ledger: { replies: string[]; texts: string[]; voices: string[] }, context: 'dm' | 'tick'): Pick<RunResult, 'delivered' | 'attachments' | 'narrationLeaked' | 'tokenLeaked' | 'silent' | 'budgetExhausted' | 'context' | 'finalText'> {
  const texts = ledger.texts
  const segs = extractTurnReply(evs)
  const fallback = context === 'dm' && ledger.replies.length === 0
    ? evs.filter((e): e is Extract<AgentEvent, { kind: 'text' }> => e.kind === 'text' && e.text.trim() !== '').map(e => e.text)
    : []
  const delivered = [...texts, ...fallback]
  const attachments = ledger.voices.map(() => 'voice')
  const err = evs.find(e => e.kind === 'error') as Extract<AgentEvent, { kind: 'error' }> | undefined
  return {
    delivered,
    attachments,
    narrationLeaked: fallback.length > 0 ? segs.narration.length : 0,
    tokenLeaked: delivered.some(t => /NO_REPLY/i.test(t)),
    silent: delivered.length === 0 && attachments.length === 0,
    budgetExhausted: err?.code === 'step_budget',
    context,
    finalText: segs.finalText.slice(0, 300),
  }
}

const inbound = (text: string, ms = Date.now()) => formatInbound({ chatId: CHAT_ID, userId: CHAT_ID, userName: '主人', accountId: 'bot-demo', msgType: 'text', text, createTimeMs: ms })

// ─── 一次运行 ────────────────────────────────────────────────────────────
async function runOnce(arm: Arm, scenario: Scenario, run: number, gw: ReturnType<typeof gatewayConfig>): Promise<RunResult> {
  let ledger = newLedger()
  const cur = () => ledger
  const daemon = arm === 'daemon'
  const rt = daemon ? fakeDeliveryRuntime(cur) : undefined
  const real = createAiSdkChatModel({ baseURL: gw.baseURL, apiKey: gw.apiKey, model: gw.model })
  const h = wrapModel(real, arm, cur)
  const opts: HarnessProviderOptions = {
    makeChatModel: () => h.model,
    makeMcpBridge: async () => createMcpToolBridge({ wechat: { command: 'unused' } as any }, { makeClient: async () => fakeWechatMcpClient(cur, rt ? () => rt : undefined) }),
    makeBuiltins: fakeBuiltins(cur),
    // 基线与其它候选都在「没有尾巴守卫」的循环上量;shipped 才用 provider 里的正式实现。
    // 灌脚本历史(场景 b)时守卫一律关 —— 各 arm 看到的历史必须一字不差;
    // 场景 b_guarded_seed 例外:故意让脚本历史也过守卫(meta 尾巴进不了历史)。
    replyTailGuard: () => arm === 'shipped' && (h.state.script === null || scenario === 'b_guarded_seed'),
    log: (tag) => { if (tag === 'REPLY_TAIL_DROPPED') cur().dropped.push(...h.state.lastCalls) },
    cwd: STATE_DIR,
    maxSteps: HARNESS_MAX_STEPS,
  }
  const provider = createOpenAiAgentProvider(opts)
  const session = await provider.spawn({ alias: 'demo', path: STATE_DIR }, {
    tierProfile: TIER_PROFILES.admin, permissionMode: 'dangerously', chatId: CHAT_ID,
    appendInstructions: systemPrompt(arm, gw.model),
  } as any)

  const drain = async (text: string) => {
    const evs: AgentEvent[] = []
    for await (const ev of session.dispatch(text)) evs.push(ev)
    return evs
  }
  /** daemon 臂的一轮:和协调器一样 —— 开轮(附件登记得上)→ 跑 → 只有完成的轮交付最后的话。 */
  const daemonTurn = async (text: string, context: 'dm' | 'tick') => {
    // 和协调器一样按能力表声明策略:openai 是聊天型(all_segments)。
    const handle = rt!.begin(CHAT_ID, { mode: 'daemon', context, providerId: 'openai', textStrategy: replyTextStrategyFor('openai') })
    const evs = await drain(text)
    if (evs.some(e => e.kind === 'error')) { handle.abandon('error'); return { evs, parts: undefined, report: undefined } }
    const parts = extractTurnReply(evs)
    return { evs, parts, report: await handle.deliver(parts) }
  }

  let t0 = Date.now() - 3 * 60_000
  if (scenario === 'b' || scenario === 'b_guarded_seed') {
    for (const s of SEED_TURNS) {
      h.state.script = [...s.replies]
      await drain(inbound(s.user, t0)); t0 += 60_000
    }
    h.state.script = null
  }
  const warmup: NonNullable<RunResult['warmup']> = []
  if (scenario === 'e') {
    for (const s of SEED_TURNS) {
      ledger = newLedger()
      const turn = daemon ? await daemonTurn(inbound(s.user, t0), 'dm') : { evs: await drain(inbound(s.user, t0)), parts: undefined, report: undefined }
      t0 += 60_000
      const evs = turn.evs
      const tools = evs.filter((e): e is Extract<AgentEvent, { kind: 'tool_call' }> => e.kind === 'tool_call').map(e => e.tool)
      warmup.push({ replies: ledger.replies, nonReplyTools: tools.filter(t => !SPEAKING_TOOLS.has(t)), dropped: ledger.dropped, delivered: daemon ? [...ledger.delivered] : measureLegacy(evs, ledger, 'dm').delivered })
    }
  }
  let prompt = promptFor(scenario, arm)
  if (scenario === 'b_cold') {
    const recent: HandoffTurn[] = []
    for (const s of SEED_TURNS) {
      recent.push({ dir: 'in', text: s.user, ts: '' })
      for (const r of s.replies) recent.push({ dir: 'out', text: r, ts: '' })
    }
    prompt = `${buildColdStartBlock('openai', recent)}\n\n${prompt}`
  }

  ledger = newLedger()
  const start = Date.now()
  const turn = daemon ? await daemonTurn(prompt, contextOf(scenario)) : { evs: await drain(prompt), parts: undefined, report: undefined }
  const evs = turn.evs
  await session.close()
  const toolEvents = evs.filter((e): e is Extract<AgentEvent, { kind: 'tool_call' }> => e.kind === 'tool_call').map(e => e.tool)
  const err = evs.find(e => e.kind === 'error') as any
  const finish = evs.find(e => e.kind === 'result') as any
  return {
    arm, scenario, run,
    replies: ledger.replies,
    nonReplyTools: toolEvents.filter(t => !SPEAKING_TOOLS.has(t)),
    steps: finish?.numTurns ?? ledger.modelCalls,
    modelCalls: ledger.modelCalls,
    cleanEnd: !err,
    ...(err ? { error: String(err.code ?? err.message ?? 'error') } : {}),
    dropped: ledger.dropped,
    assistantText: evs.filter(e => e.kind === 'text').map((e: any) => e.text).join('\n').slice(0, 300),
    ms: Date.now() - start,
    ...(warmup.length ? { warmup } : {}),
    ...(daemon ? measureDaemon(evs, ledger, turn.parts, turn.report, contextOf(scenario)) : measureLegacy(evs, ledger, contextOf(scenario))),
  }
}

// ─── agy 臂(回复交付第 2 步,2026-10-03)────────────────────────────────────
//
// 真 agy(订阅版 Gemini,连 Google —— 每一轮之前先过 bx),沙盒工作区里的自定义 agent(见 agy-sandbox.ts:
// 不继承主人的全局 MCP / skills / rules),MCP 是**生产的** wechat MCP 入口,背后是本进程里的假 internal API。
// agy 是外部进程,回合历史不能像 openai 臂那样脚本化灌进去:b 用生产里换 provider 时的冷启动交接块
// (buildColdStartBlock)把同一段连发历史放进提示 —— 两臂一样。
export interface AgyRunConfig { bin: string; workspace: string; projectId: string; model: string; turnTimeoutMs: number; rawLog?: string }

function agySystemPrompt(arm: Arm, model: string): string {
  return buildSystemPrompt({
    providerId: 'agy', model, peerProviderId: 'claude', companionEnabled: false, delegateAvailable: false,
    daemonOpsAvailable: true, fileLocateAvailable: true, bubbleReplies: true,
    // agy 的 MCP 钉死 trusted(没有 message);和 wire-instructions 一样按能力表推。
    ...(arm === 'agy_daemon' ? { replyDelivery: 'final_text' as const, replyText: replyTextStrategyFor('agy'), messageToolAvailable: false } : {}),
  })
}

function agyPromptFor(scenario: Scenario, arm: Arm): string {
  const daemon = arm === 'agy_daemon'
  if (scenario === 'g') return buildPushTickText({ nowIso: G_NOW_ISO, defaultChatId: CHAT_ID, intention: G_INTENTION }, { replyDelivery: daemon ? 'final_text' : 'tool', allSegments: daemon && replyTextStrategyFor('agy') === 'all_segments' })
  const base = inbound(SCENARIO_PROMPT[scenario])
  if (scenario !== 'b') return base
  const recent: HandoffTurn[] = []
  for (const s of SEED_TURNS) {
    recent.push({ dir: 'in', text: s.user, ts: '' })
    for (const r of s.replies) recent.push({ dir: 'out', text: r, ts: '' })
  }
  return `${buildColdStartBlock('agy', recent)}\n\n${base}`
}

export async function runOnceAgy(arm: Arm, scenario: Scenario, run: number, cfg: AgyRunConfig): Promise<RunResult> {
  await assertBxProtected() // 每一轮之前:不保护就不调 agy(连 Google)
  let ledger = newLedger()
  const cur = () => ledger
  const daemon = arm === 'agy_daemon'
  const rt = daemon ? fakeDeliveryRuntime(cur) : undefined
  const api = fakeInternalApi(cur, rt ? () => rt : undefined, { sharedTokenProvider: 'agy' })
  const server = await startFakeInternalApi(STATE_DIR, (m, path, body) => api.request(m, path, body))
  writeAgySandboxWorkspace(cfg.workspace, { mode: daemon ? 'daemon' : 'tool', api: server, stateDir: STATE_DIR })
  const provider = createAgyAgentProvider({
    bin: cfg.bin, model: cfg.model, turnTimeoutMs: cfg.turnTimeoutMs,
    log: () => {},
    spawnFn: sandboxSpawnFn({ bin: cfg.bin, workspace: cfg.workspace, projectId: cfg.projectId, onArgs: () => { cur().modelCalls++ }, ...(cfg.rawLog ? { rawLog: (c: string) => appendFileSync(cfg.rawLog!, c) } : {}) }),
  })
  try {
    const session = await provider.spawn({ alias: 'demo', path: cfg.workspace }, {
      tierProfile: TIER_PROFILES.admin, permissionMode: 'dangerously', chatId: CHAT_ID,
      appendInstructions: agySystemPrompt(arm, cfg.model),
    } as any)
    const drain = async (text: string) => {
      const evs: AgentEvent[] = []
      for await (const ev of session.dispatch(text)) evs.push(ev)
      return evs
    }
    const daemonTurn = async (text: string, context: 'dm' | 'tick') => {
      const handle = rt!.begin(CHAT_ID, { mode: 'daemon', context, providerId: 'agy', textStrategy: replyTextStrategyFor('agy') })
      const evs = await drain(text)
      if (evs.some(e => e.kind === 'error')) { handle.abandon('error'); return { evs, parts: undefined, report: undefined } }
      const parts = extractTurnReply(evs)
      return { evs, parts, report: await handle.deliver(parts) }
    }
    const warmup: NonNullable<RunResult['warmup']> = []
    let t0 = Date.now() - 3 * 60_000
    if (scenario === 'e') {
      for (const s of SEED_TURNS) {
        await assertBxProtected()
        ledger = newLedger()
        const turn = daemon ? await daemonTurn(inbound(s.user, t0), 'dm') : { evs: await drain(inbound(s.user, t0)), parts: undefined, report: undefined }
        t0 += 60_000
        const tools = turn.evs.filter((e): e is Extract<AgentEvent, { kind: 'tool_call' }> => e.kind === 'tool_call').map(e => e.tool)
        warmup.push({ replies: ledger.replies, nonReplyTools: tools.filter(t => !SPEAKING_TOOLS.has(t)), dropped: [], delivered: daemon ? [...ledger.delivered] : measureLegacy(turn.evs, ledger, 'dm').delivered })
      }
      await assertBxProtected()
    }
    ledger = newLedger()
    const start = Date.now()
    const prompt = agyPromptFor(scenario, arm)
    const turn = daemon ? await daemonTurn(prompt, contextOf(scenario)) : { evs: await drain(prompt), parts: undefined, report: undefined }
    await session.close()
    const evs = turn.evs
    const toolEvents = evs.filter((e): e is Extract<AgentEvent, { kind: 'tool_call' }> => e.kind === 'tool_call').map(e => e.tool)
    const err = evs.find(e => e.kind === 'error') as any
    const finish = evs.find(e => e.kind === 'result') as any
    const measured = daemon ? measureDaemon(evs, ledger, turn.parts, turn.report, contextOf(scenario), replyTextStrategyFor('agy')) : measureLegacy(evs, ledger, contextOf(scenario))
    return {
      arm, scenario, run,
      replies: ledger.replies,
      nonReplyTools: toolEvents.filter(t => !SPEAKING_TOOLS.has(t)),
      steps: finish?.numTurns ?? 0,
      modelCalls: ledger.modelCalls,
      cleanEnd: !err,
      ...(err ? { error: String(err.code ?? err.message ?? 'error').slice(0, 200) } : {}),
      dropped: [],
      assistantText: evs.filter(e => e.kind === 'text').map((e: any) => e.text).join('\n').slice(0, 300),
      ms: Date.now() - start,
      ...(warmup.length ? { warmup } : {}),
      ...measured,
      doubleSend: doubleSends(measured.delivered ?? []),
      apiPaths: [...new Set(ledger.api)],
    }
  } finally {
    await server.close()
  }
}

// ─── Codex 真模型臂(回复交付第 4 步,2026-10-03)───────────────────────────────
//
// 真 codex CLI + 真模型(api.openai.com,每一轮之前先过 bx),沙盒 CODEX_HOME(只复制登录,见 codex-sandbox.ts),
// **生产的** Codex provider(createCodexAgentProvider:事件翻译、指令前置、超时)+ 生产的 wechat MCP 入口,背后是本进程
// 里的假 internal API。legacy 臂量的是「协调器会发什么」:调过认得出的 reply ⇒ 只有 reply 路由发的;没调 ⇒
// FALLBACK 把每条 agent_message 各发一条(和 conversation-coordinator 的 solo 分支同一个判定 isReplyToolCall)。
export interface CodexRunConfig { bin: string; model: string; effort: string; root: string; approveMcp: boolean; rawLog?: string }

function codexSystemPrompt(arm: Arm, model: string): string {
  return buildSystemPrompt({
    providerId: 'codex', model, peerProviderId: 'claude', companionEnabled: false, delegateAvailable: false,
    daemonOpsAvailable: true, fileLocateAvailable: true, bubbleReplies: true,
    // owner 会话是 admin,codex 的 MCP 按会话 tier ⇒ 有 message(和 wire-instructions 一样按能力表推)。
    ...(arm === 'codex_real_daemon' ? { replyDelivery: 'final_text' as const, replyText: replyTextStrategyFor('codex'), messageToolAvailable: true } : {}),
  })
}

export async function runOnceCodexReal(arm: Arm, scenario: Scenario, run: number, cfg: CodexRunConfig): Promise<RunResult> {
  await assertBxProtected() // 每一轮之前:不保护就不调(codex 连 api.openai.com)
  let ledger = newLedger()
  const cur = () => ledger
  const daemon = arm === 'codex_real_daemon'
  const rt = daemon ? fakeDeliveryRuntime(cur) : undefined
  const api = fakeInternalApi(cur, rt ? () => rt : undefined)
  const runRoot = join(cfg.root, `${arm}-${scenario}-${run}-${Date.now()}`)
  mkdirSync(runRoot, { recursive: true })
  const sb = makeCodexSandbox(runRoot, { model: cfg.model, effort: cfg.effort })
  assertSandboxTarget(sb, cfg.model)
  const server = await startFakeInternalApi(runRoot, (m, path, body) => api.request(m, path, body))
  const raw: unknown[] = []
  const mcpEnv = { ...sandboxMcpEnv({ mode: daemon ? 'daemon' : 'tool', api: server, stateDir: STATE_DIR }), WECHAT_PARTICIPANT_TAG: 'codex', WECHAT_SESSION_TIER: 'admin' }
  const provider = createCodexAgentProvider({
    codexPathOverride: cfg.bin,
    model: cfg.model,
    codexFactory: sandboxCodexFactory({ sandbox: sb, approveMcp: cfg.approveMcp, onEvent: (ev) => raw.push(ev), onRun: () => { cur().modelCalls++ } }),
    mcpServers: { wechat: { command: process.execPath, args: [WECHAT_MCP_MAIN], env: mcpEnv } },
    codexTargetOptions: () => ({ env: { HOME: sb.home, CODEX_HOME: sb.codexHome }, systemDir: null }),
  })
  try {
    const session = await provider.spawn({ alias: 'demo', path: sb.workdir }, {
      tierProfile: TIER_PROFILES.admin, permissionMode: 'strict', chatId: CHAT_ID,
      appendInstructions: codexSystemPrompt(arm, cfg.model),
    } as any)
    const drain = async (text: string) => {
      const evs: AgentEvent[] = []
      for await (const ev of session.dispatch(text)) evs.push(ev)
      return evs
    }
    const start = Date.now()
    const prompt = scenario === 'g'
      ? buildPushTickText({ nowIso: G_NOW_ISO, defaultChatId: CHAT_ID, intention: G_INTENTION }, { replyDelivery: daemon ? 'final_text' : 'tool', allSegments: false })
      : inbound(SCENARIO_PROMPT[scenario])
    let evs: AgentEvent[]
    let parts: { finalText: string; narration: string[] } | undefined
    let report: { delivery: string } | undefined
    if (daemon) {
      const handle = rt!.begin(CHAT_ID, { mode: 'daemon', context: contextOf(scenario), providerId: 'codex', textStrategy: replyTextStrategyFor('codex') })
      evs = await drain(prompt)
      if (evs.some(e => e.kind === 'error')) handle.abandon('error')
      else { parts = extractTurnReply(evs); report = await handle.deliver(parts) }
    } else {
      evs = await drain(prompt)
    }
    await session.close()
    if (cfg.rawLog) appendFileSync(cfg.rawLog, JSON.stringify({ arm, scenario, run, approveMcp: cfg.approveMcp, events: raw }) + '\n')
    const toolEvents = evs.filter((e): e is Extract<AgentEvent, { kind: 'tool_call' }> => e.kind === 'tool_call')
    const err = evs.find(e => e.kind === 'error') as any
    // legacy:协调器的判定 —— 认得出的 reply(哪怕被拒)⇒ 文字全丢;认不出 ⇒ FALLBACK 每条 agent_message 一条。推送只认 reply 工具。
    const measured = daemon
      ? measureDaemon(evs, ledger, parts, report, contextOf(scenario), replyTextStrategyFor('codex'))
      : (() => {
          const ctx = contextOf(scenario)
          const replied = toolEvents.some(isReplyToolCall)
          const segs = extractTurnReply(evs)
          const fallback = ctx === 'dm' && !replied && !err ? evs.filter((e): e is Extract<AgentEvent, { kind: 'text' }> => e.kind === 'text' && e.text.trim() !== '').map(e => e.text) : []
          const delivered = [...ledger.texts, ...fallback]
          const attachments = ledger.voices.map(() => 'voice')
          return {
            delivered, attachments,
            narrationLeaked: fallback.length > 0 ? segs.narration.length : 0,
            tokenLeaked: delivered.some(t => /NO_REPLY/i.test(t)),
            silent: delivered.length === 0 && attachments.length === 0,
            budgetExhausted: false, context: ctx, finalText: segs.finalText.slice(0, 300),
          }
        })()
    return {
      arm, scenario, run,
      replies: ledger.replies,
      nonReplyTools: toolEvents.map(e => e.tool).filter(t => !SPEAKING_TOOLS.has(t)),
      steps: evs.filter(e => e.kind === 'tool_call').length,
      modelCalls: ledger.modelCalls,
      cleanEnd: !err,
      ...(err ? { error: String(err.code ?? err.message ?? 'error').slice(0, 200) } : {}),
      dropped: [],
      assistantText: evs.filter(e => e.kind === 'text').map((e: any) => e.text).join('\n').slice(0, 300),
      ms: Date.now() - start,
      ...measured,
      doubleSend: doubleSends(measured.delivered ?? []),
      apiPaths: [...new Set(ledger.api), ...(cfg.approveMcp ? [] : ['variant:strict']), ...toolEvents.map(e => `tool:${e.server ? `${e.server}/` : ''}${e.tool}`)],
    }
  } finally {
    await server.close()
  }
}

// ─── Claude 真模型臂(回复交付第 5 步,2026-10-03)───────────────────────────────
//
// 真 Claude Code + 真模型(api.anthropic.com,每一轮之前先过 bx),沙盒 HOME(登录只读、只经环境变量给 access token,
// 见 claude-sandbox.ts),**生产的** Claude provider(createClaudeAgentProvider:消息翻译、事件顺序、子 agent / 错误过滤)
// + 生产的 wechat MCP 入口,背后是本进程里的假 internal API。legacy 臂量的是「协调器会发什么」(同 codex 真模型臂)。
// 另外记两件第 5 步要核对的事(进 apiPaths):SDK 是不是每个内容块一条 assistant 消息(shape:*),以及 result.result
// 和分段算出来的最后的话对不对得上(final_check:*)。
export interface ClaudeRunConfig { bin: string; model: string; root: string; rawLog?: string }

function claudeSystemPrompt(arm: Arm, model: string): string {
  return buildSystemPrompt({
    providerId: 'claude', model, peerProviderId: 'codex', companionEnabled: false, delegateAvailable: false,
    daemonOpsAvailable: true, fileLocateAvailable: true, bubbleReplies: true,
    ...(arm === 'claude_real_daemon' ? { replyDelivery: 'final_text' as const, replyText: replyTextStrategyFor('claude'), messageToolAvailable: true } : {}),
  })
}

export async function runOnceClaudeReal(arm: Arm, scenario: Scenario, run: number, cfg: ClaudeRunConfig, onTurn: () => void): Promise<RunResult> {
  await assertBxProtected() // 每一轮之前:不保护就不调(Claude 连 api.anthropic.com)
  let ledger = newLedger()
  const cur = () => ledger
  const daemon = arm === 'claude_real_daemon'
  const rt = daemon ? fakeDeliveryRuntime(cur) : undefined
  const api = fakeInternalApi(cur, rt ? () => rt : undefined)
  const runRoot = join(cfg.root, `${arm}-${scenario}-${run}-${Date.now()}`)
  mkdirSync(runRoot, { recursive: true })
  const sb = makeClaudeSandbox(runRoot)
  assertClaudeTarget(sb, cfg.model)
  const server = await startFakeInternalApi(runRoot, (m, path, body) => api.request(m, path, body))
  const raw: unknown[] = []
  const builtins: string[] = []
  const mcpEnv = { ...sandboxMcpEnv({ mode: daemon ? 'daemon' : 'tool', api: server, stateDir: STATE_DIR }), WECHAT_PARTICIPANT_TAG: 'claude', WECHAT_SESSION_TIER: 'admin' }
  const append = claudeSystemPrompt(arm, cfg.model)
  const provider = createClaudeAgentProvider({
    sdkOptionsForProject: () => sandboxSdkOptions(sb, { model: cfg.model, claudeBin: cfg.bin, append, wechat: { command: process.execPath, args: [WECHAT_MCP_MAIN], env: mcpEnv }, canUseTool: sandboxCanUseTool(n => builtins.push(n)) }),
    queryImpl: teeQuery({ onMessage: (m) => raw.push(m), onTurn: () => { cur().modelCalls++; onTurn() } }),
  })
  try {
    const session = await provider.spawn({ alias: 'demo', path: sb.workdir }, { tierProfile: TIER_PROFILES.admin, permissionMode: 'strict', chatId: CHAT_ID } as any)
    const drain = async (text: string) => {
      const evs: AgentEvent[] = []
      for await (const ev of session.dispatch(text)) evs.push(ev)
      return evs
    }
    const turnOnce = async (text: string, ctx: 'dm' | 'tick') => {
      if (!daemon) return { evs: await drain(text), parts: undefined, report: undefined }
      const handle = rt!.begin(CHAT_ID, { mode: 'daemon', context: ctx, providerId: 'claude', textStrategy: replyTextStrategyFor('claude') })
      const evs = await drain(text)
      if (evs.some(e => e.kind === 'error')) { handle.abandon('error'); return { evs, parts: undefined, report: undefined } }
      const parts = extractTurnReply(evs)
      return { evs, parts, report: await handle.deliver(parts) }
    }
    // legacy:协调器的判定 —— 认得出的 reply ⇒ 文字全丢;认不出 ⇒ FALLBACK 每段文字一条。推送只认 reply 工具。
    const legacyMeasure = (evs: AgentEvent[], ctx: 'dm' | 'tick') => {
      const toolEvents = evs.filter((e): e is Extract<AgentEvent, { kind: 'tool_call' }> => e.kind === 'tool_call')
      const err = evs.find(e => e.kind === 'error')
      const replied = toolEvents.some(isReplyToolCall)
      const segs = extractTurnReply(evs)
      const fallback = ctx === 'dm' && !replied && !err ? evs.filter((e): e is Extract<AgentEvent, { kind: 'text' }> => e.kind === 'text' && e.text.trim() !== '').map(e => e.text) : []
      const delivered = [...ledger.texts, ...fallback]
      const attachments = ledger.voices.map(() => 'voice')
      return {
        delivered, attachments,
        narrationLeaked: fallback.length > 0 ? segs.narration.length : 0,
        tokenLeaked: delivered.some(t => /NO_REPLY/i.test(t)),
        silent: delivered.length === 0 && attachments.length === 0,
        budgetExhausted: false, context: ctx, finalText: segs.finalText.slice(0, 300),
      }
    }
    const warmup: NonNullable<RunResult['warmup']> = []
    if (scenario === 'e') {
      let t0 = Date.now() - 3 * 60_000
      for (const s of SEED_TURNS) {
        await assertBxProtected()
        ledger = newLedger()
        const t = await turnOnce(inbound(s.user, t0), 'dm'); t0 += 60_000
        const tools = t.evs.filter((e): e is Extract<AgentEvent, { kind: 'tool_call' }> => e.kind === 'tool_call').map(e => e.tool)
        warmup.push({ replies: ledger.replies, nonReplyTools: tools.filter(x => !SPEAKING_TOOLS.has(x)), dropped: [], delivered: daemon ? [...ledger.delivered] : legacyMeasure(t.evs, 'dm').delivered })
      }
      await assertBxProtected()
    }
    ledger = newLedger()
    const start = Date.now()
    const ctx = contextOf(scenario)
    const prompt = scenario === 'g'
      ? buildPushTickText({ nowIso: G_NOW_ISO, defaultChatId: CHAT_ID, intention: G_INTENTION }, { replyDelivery: daemon ? 'final_text' : 'tool', allSegments: false })
      : inbound(SCENARIO_PROMPT[scenario])
    const rawStart = raw.length
    const turn = await turnOnce(prompt, ctx)
    await session.close()
    assertKeychainUntouched(sb)
    const evs = turn.evs
    const turnRaw = raw.slice(rawStart) as Array<{ type?: string; message?: { content?: unknown[] }; parent_tool_use_id?: string | null }>
    if (cfg.rawLog) appendFileSync(cfg.rawLog, JSON.stringify({ arm, scenario, run, messages: turnRaw.filter(m => m.type !== 'system') }) + '\n')
    const toolEvents = evs.filter((e): e is Extract<AgentEvent, { kind: 'tool_call' }> => e.kind === 'tool_call')
    const err = evs.find(e => e.kind === 'error') as any
    const resultEv = evs.find(e => e.kind === 'result') as Extract<AgentEvent, { kind: 'result' }> | undefined
    const segFinal = extractTurnReply(evs).finalText.trim()
    const finalCheck = resultEv?.finalText === undefined ? 'none' : resultEv.finalText.trim() === segFinal ? 'same' : 'differs'
    const multiBlock = turnRaw.some(m => m.type === 'assistant' && Array.isArray(m.message?.content) && m.message!.content!.filter((b: any) => b?.type !== 'thinking').length > 1)
    const measured = daemon ? measureDaemon(evs, ledger, turn.parts, turn.report, ctx, replyTextStrategyFor('claude')) : legacyMeasure(evs, ctx)
    return {
      arm, scenario, run,
      replies: ledger.replies,
      nonReplyTools: toolEvents.map(e => e.tool).filter(t => !SPEAKING_TOOLS.has(t)),
      steps: toolEvents.length,
      modelCalls: ledger.modelCalls,
      cleanEnd: !err,
      ...(err ? { error: String(err.code ?? err.message ?? 'error').slice(0, 200) } : {}),
      dropped: [],
      assistantText: evs.filter(e => e.kind === 'text').map((e: any) => e.text).join('\n').slice(0, 300),
      ms: Date.now() - start,
      ...(warmup.length ? { warmup } : {}),
      ...measured,
      doubleSend: doubleSends(measured.delivered ?? []),
      apiPaths: [...new Set(ledger.api), `shape:${multiBlock ? 'bundled' : 'per_block'}`, `final_check:${finalCheck}`, ...builtins.map(b => `denied:${b}`), ...toolEvents.map(e => `tool:${e.server ? `${e.server}/` : ''}${e.tool}`)],
    }
  } finally {
    await server.close()
  }
}

async function main() {
  const args = process.argv.slice(2)
  const get = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined }
  const sumFile = get('--summarize')
  const gateFile = get('--gate')
  if (sumFile || gateFile) {
    const rows = readFileSync((sumFile ?? gateFile)!, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as RunResult)
    const [gArm, gBase] = (get('--gate-arms') ?? 'daemon,baseline').split(',') as [Arm, Arm]
    console.log(sumFile ? summarize(rows) : formatGate(evaluateGate(rows, gArm, gBase)))
    return
  }
  const agyInit = get('--agy-init')
  if (agyInit) {
    await assertBxProtected()
    mkdirSync(agyInit, { recursive: true })
    console.log(await createAgyProject({ bin: get('--agy-bin') ?? 'agy', workspace: agyInit }))
    return
  }
  const arm = (get('--arm') ?? 'baseline') as Arm | 'cursor' | 'codex' | 'claude'
  const out = get('--out') ?? join(STATE_DIR, 'results.jsonl')
  if (arm === 'cursor' || arm === 'cursor_legacy' || arm === 'cursor_daemon') {
    // 不连模型、不过 bx:纯进程内(见 cursor-fixture.ts 文件头)。每个场景按外部条件跑(recorded / drift / strict)。
    const arms: CursorArm[] = arm === 'cursor' ? ['cursor_legacy', 'cursor_daemon'] : [arm]
    const scenarios = get('--scenarios') ? get('--scenarios')!.split(',') as Scenario[] : CURSOR_SCENARIOS
    const rows = await runCursorGate(arms, scenarios)
    for (const r of rows) appendFileSync(out, JSON.stringify(r) + '\n')
    console.log(summarize(rows))
    console.log('')
    console.log(byVariant(rows))
    if (arms.length === 2) { console.log(''); console.log(formatGate(evaluateGate(rows, 'cursor_daemon', 'cursor_legacy'))); console.log(''); console.log(formatGate(evaluateGate(rows, 'cursor_legacy', 'cursor_legacy'))) }
    return
  }
  if (arm === 'codex' || arm === 'codex_legacy' || arm === 'codex_daemon') {
    // 剧本臂:不连模型、不过 bx,纯进程内(见 codex-fixture.ts 文件头)。
    const arms: CodexArm[] = arm === 'codex' ? ['codex_legacy', 'codex_daemon'] : [arm]
    const scenarios = get('--scenarios') ? get('--scenarios')!.split(',') as Scenario[] : CODEX_SCENARIOS
    const rows = await runCodexFixtureGate(arms, scenarios)
    for (const r of rows) appendFileSync(out, JSON.stringify(r) + '\n')
    console.log(summarize(rows))
    console.log('')
    console.log(codexByVariant(rows))
    if (arms.length === 2) { console.log(''); console.log(formatGate(evaluateGate(rows, 'codex_daemon', 'codex_legacy'))); console.log(''); console.log(formatGate(evaluateGate(rows, 'codex_legacy', 'codex_legacy'))) }
    return
  }
  if (arm === 'claude' || arm === 'claude_legacy' || arm === 'claude_daemon') {
    // 剧本臂:不连模型、不过 bx,纯进程内(见 claude-fixture.ts 文件头)。
    const arms: ClaudeArm[] = arm === 'claude' ? ['claude_legacy', 'claude_daemon'] : [arm]
    const scenarios = get('--scenarios') ? get('--scenarios')!.split(',') as Scenario[] : CLAUDE_SCENARIOS
    const rows = await runClaudeFixtureGate(arms, scenarios)
    for (const r of rows) appendFileSync(out, JSON.stringify(r) + '\n')
    console.log(summarize(rows))
    console.log('')
    console.log(claudeByVariant(rows))
    if (arms.length === 2) { console.log(''); console.log(formatGate(evaluateGate(rows, 'claude_daemon', 'claude_legacy'))); console.log(''); console.log(formatGate(evaluateGate(rows, 'claude_legacy', 'claude_legacy'))) }
    return
  }
  const scenarios = (get('--scenarios') ?? 'a,b,c,d').split(',') as Scenario[]
  const runs = Number(get('--runs') ?? '5')
  if (arm === 'claude_real_legacy' || arm === 'claude_real_daemon') {
    const budget = Number(get('--budget') ?? '0')
    if (!(budget > 0)) throw new Error('claude 真模型臂要 --budget <这一批最多几轮>(真 Anthropic 调用,总上限 40)')
    const cfg: ClaudeRunConfig = {
      bin: get('--claude-bin') ?? join(homedir(), '.local/bin/claude'),
      model: get('--claude-model') ?? DEFAULT_CLAUDE_MODEL,
      root: get('--claude-root') ?? join(STATE_DIR, 'claude'),
      ...(get('--claude-raw') ? { rawLog: get('--claude-raw')! } : {}),
    }
    console.error(`[reply-once] arm=${arm} scenarios=${scenarios.join(',')} runs=${runs} model=${cfg.model} budget=${budget} out=${out} bx=${await assertBxProtected()}`)
    const rows: RunResult[] = []
    let used = 0
    for (const sc of scenarios) {
      for (let r = 1; r <= runs; r++) {
        // e 一次是四轮,预算按真回合数(每条 user 消息)扣。
        if (used + (sc === 'e' ? 4 : 1) > budget) { console.error(`  预算不够(${used}/${budget}),停`); break }
        let res: RunResult
        try { res = await runOnceClaudeReal(arm, sc, r, cfg, () => { used++ }) } catch (e) {
          if (/网络未受保护|找不到 bx|拒跑|钥匙串|登录/.test(String(e))) throw e // 守护 / 沙盒护栏:整批中止
          res = { arm, scenario: sc, run: r, replies: [], nonReplyTools: [], steps: 0, modelCalls: 0, cleanEnd: false, error: String(e).slice(0, 200), dropped: [], assistantText: '', ms: 0 }
        }
        rows.push(res)
        appendFileSync(out, JSON.stringify(res) + '\n')
        for (const [k, w] of (res.warmup ?? []).entries()) console.error(`  ${sc}#${r} warm${k + 1}: delivered=${JSON.stringify(w.delivered)} tools=${JSON.stringify(w.nonReplyTools)}`)
        console.error(`  ${sc}#${r}: delivered=${(res.delivered ?? res.replies).length} ${JSON.stringify(res.delivered ?? res.replies)}${res.attachments?.length ? ` attachments=${res.attachments.join(',')}` : ''}${res.silent ? ' silent' : ''} final=${JSON.stringify(res.finalText ?? '')} api=${JSON.stringify(res.apiPaths ?? [])} ${res.error ?? 'ok'} ${res.ms}ms`)
      }
    }
    console.error(`  真模型回合:${used}`)
    console.log(summarize(rows))
    return
  }
  if (arm === 'codex_real_legacy' || arm === 'codex_real_daemon') {
    const budget = Number(get('--budget') ?? '0')
    if (!(budget > 0)) throw new Error('codex 真模型臂要 --budget <这一批最多几轮>(真 OpenAI 调用,主人定的总上限 40)')
    const cfg: CodexRunConfig = {
      bin: get('--codex-bin') ?? join(homedir(), '.local/bin/codex'),
      model: get('--codex-model') ?? 'gpt-6.1-sol',
      effort: get('--codex-effort') ?? 'medium',
      root: get('--codex-root') ?? join(STATE_DIR, 'codex'),
      approveMcp: !args.includes('--strict'),
      ...(get('--codex-raw') ? { rawLog: get('--codex-raw')! } : {}),
    }
    console.error(`[reply-once] arm=${arm} scenarios=${scenarios.join(',')} runs=${runs} model=${cfg.model}/${cfg.effort} approveMcp=${cfg.approveMcp} out=${out} bx=${await assertBxProtected()}`)
    const rows: RunResult[] = []
    let used = 0
    for (const sc of scenarios) {
      for (let r = 1; r <= runs; r++) {
        if (used >= budget) { console.error(`  预算用完(${budget} 轮),停`); break }
        let res: RunResult
        try { res = await runOnceCodexReal(arm, sc, r, cfg) } catch (e) {
          if (/网络未受保护|找不到 bx|拒跑/.test(String(e))) throw e // 守护 / 沙盒护栏:整批中止
          res = { arm, scenario: sc, run: r, replies: [], nonReplyTools: [], steps: 0, modelCalls: 1, cleanEnd: false, error: String(e).slice(0, 200), dropped: [], assistantText: '', ms: 0 }
        }
        used += Math.max(1, res.modelCalls)
        rows.push(res)
        appendFileSync(out, JSON.stringify(res) + '\n')
        console.error(`  ${sc}#${r}: delivered=${(res.delivered ?? res.replies).length} ${JSON.stringify(res.delivered ?? res.replies)}${res.attachments?.length ? ` attachments=${res.attachments.join(',')}` : ''}${res.silent ? ' silent' : ''} final=${JSON.stringify(res.finalText ?? '')} tools=${JSON.stringify(res.nonReplyTools)} api=${JSON.stringify(res.apiPaths ?? [])} ${res.error ?? 'ok'} ${res.ms}ms`)
      }
    }
    console.error(`  真模型回合:${used}`)
    console.log(summarize(rows))
    return
  }
  if (arm === 'agy_legacy' || arm === 'agy_daemon') {
    const workspace = get('--agy-ws'), projectId = get('--agy-project')
    if (!workspace || !projectId) throw new Error('agy 臂要 --agy-ws <沙盒工作区> --agy-project <id>(先跑 --agy-init <目录>)')
    const cfg: AgyRunConfig = { bin: get('--agy-bin') ?? 'agy', workspace, projectId, model: get('--agy-model') ?? DEFAULT_AGY_MODEL, turnTimeoutMs: 180_000, ...(get('--agy-raw') ? { rawLog: get('--agy-raw')! } : {}) }
    console.error(`[reply-once] arm=${arm} scenarios=${scenarios.join(',')} runs=${runs} model=${cfg.model} ws=${workspace} out=${out} bx=${await assertBxProtected()}`)
    const rows: RunResult[] = []
    for (const sc of scenarios) {
      for (let r = 1; r <= runs; r++) {
        let res: RunResult
        try { res = await runOnceAgy(arm, sc, r, cfg) } catch (e) {
          if (String(e).includes('网络未受保护') || String(e).includes('找不到 bx')) throw e // 守护:整批中止
          res = { arm, scenario: sc, run: r, replies: [], nonReplyTools: [], steps: 0, modelCalls: 0, cleanEnd: false, error: String(e).slice(0, 200), dropped: [], assistantText: '', ms: 0 }
        }
        rows.push(res)
        appendFileSync(out, JSON.stringify(res) + '\n')
        for (const [k, w] of (res.warmup ?? []).entries()) console.error(`  ${sc}#${r} warm${k + 1}: delivered=${JSON.stringify(w.delivered)} tools=${JSON.stringify(w.nonReplyTools)}`)
        console.error(`  ${sc}#${r}: delivered=${(res.delivered ?? res.replies).length} ${JSON.stringify(res.delivered ?? res.replies)}${res.attachments?.length ? ` attachments=${res.attachments.join(',')}` : ''}${res.silent ? ' silent' : ''} tools=${JSON.stringify(res.nonReplyTools)} api=${JSON.stringify(res.apiPaths ?? [])} calls=${res.modelCalls} ${res.error ?? 'ok'}`)
      }
    }
    console.log(summarize(rows))
    return
  }
  assertProviderSeams(arm)
  const gw = gatewayConfig()
  assertGatewayHost(gw.baseURL)
  console.error(`[reply-once] arm=${arm} scenarios=${scenarios.join(',')} runs=${runs} model=${gw.model} state=${STATE_DIR} out=${out}`)
  const rows: RunResult[] = []
  for (const sc of scenarios) {
    for (let r = 1; r <= runs; r++) {
      let res: RunResult
      try { res = await runOnce(arm, sc, r, gw) } catch (e) {
        res = { arm, scenario: sc, run: r, replies: [], nonReplyTools: [], steps: 0, modelCalls: 0, cleanEnd: false, error: String(e).slice(0, 200), dropped: [], assistantText: '', ms: 0 }
      }
      rows.push(res)
      appendFileSync(out, JSON.stringify(res) + '\n')
      for (const [k, w] of (res.warmup ?? []).entries()) console.error(`  ${sc}#${r} warm${k + 1}: replies=${w.replies.length} ${JSON.stringify(w.replies)} tools=${JSON.stringify(w.nonReplyTools)}${w.dropped.length ? ` dropped=${JSON.stringify(w.dropped)}` : ''}`)
      console.error(`  ${sc}#${r}: delivered=${(res.delivered ?? res.replies).length} ${JSON.stringify(res.delivered ?? res.replies)}${res.attachments?.length ? ` attachments=${res.attachments.join(',')}` : ''}${res.silent ? ' silent' : ''} tools=${JSON.stringify(res.nonReplyTools)} steps=${res.steps} ${res.error ?? 'ok'}${res.dropped.length ? ` dropped=${JSON.stringify(res.dropped)}` : ''}`)
    }
  }
  console.log(summarize(rows))
}

if (import.meta.main) await main()
