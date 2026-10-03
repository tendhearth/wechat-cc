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
 *
 * 候选(--arm):
 *   baseline     现在的 dev
 *   i_plain_ack  reply 成功回执换成纯文字「delivered」(不带任何邀请)
 *   ii_prompt    系统提示里写清楚一轮怎么结束(不在工具回执里加东西)
 *   iii_drop     循环侧:本轮已有成功 reply 后,下一步若只是 reply 且内容是元话语/近似重复 ⇒ 丢掉并结束
 *   iv_restrict  循环侧:成功 reply 之后的下一步只给 reply 族工具(可以再发,也可以不调 = 结束)
 *   v_condense   历史侧:之前几轮里的多条 reply 合并成一条再给模型看
 *   shipped      提交进 provider 的正式实现(不靠 harness 包装)
 */
import { mkdtempSync, readFileSync, appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
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
import { createOpenAiAgentProvider, type OpenAiAgentProviderOptions } from '../../../src/core/openai-agent-provider'
import { createAiSdkChatModel, type ChatModelClient, type ChatMessage, type StreamedTurn, type ToolSpec, type TurnDelta } from '../../../src/core/openai-chat-model'
import { createMcpToolBridge, type McpClientLike } from '../../../src/core/openai-mcp-bridge'
import { builtinTools, type BuiltinTool } from '../../../src/core/openai-tools'
import { buildSystemPrompt, bubbleRepliesSection } from '../../../src/core/prompt-builder'
import { formatInbound } from '../../../src/core/prompt-format'
import { buildColdStartBlock, type HandoffTurn } from '../../../src/core/provider-handoff'
import { TIER_PROFILES } from '../../../src/core/user-tier'
import type { AgentEvent } from '../../../src/core/agent-provider'

// ─── 隔离护栏 ─────────────────────────────────────────────────────────────
const STATE_DIR = mkdtempSync(join(tmpdir(), 'reply-once-'))
process.env.WECHAT_STATE_DIR = STATE_DIR
delete process.env.WECHAT_INTERNAL_API
delete process.env.WECHAT_INTERNAL_TOKEN_FILE

const CHAT_ID = 'o9demo_owner@im.wechat'
const REPLY_FAMILY = new Set(['reply', 'reply_voice'])
const HARNESS_MAX_STEPS = 12 // 生产是 25;这里够看出失控,又不烧网关

export type Arm = 'baseline' | 'i_plain_ack' | 'ii_prompt' | 'iii_drop' | 'iv_restrict' | 'v_condense' | 'shipped'
export type Scenario = 'a' | 'b' | 'b_guarded_seed' | 'b_cold' | 'c' | 'd' | 'e'

const SCENARIO_PROMPT: Record<Scenario, string> = {
  a: 'e2e 测试:回我一句简短的话就行。',
  b: 'e2e 测试:回我一句简短的话就行。',
  b_guarded_seed: 'e2e 测试:回我一句简短的话就行。',
  b_cold: 'e2e 测试:回我一句简短的话就行。',
  c: '分三条消息发给我三个周末放松的建议,每条一个。',
  d: '我现在有哪些项目?',
  // e:同一个新会话里真跑四轮(前三轮是 SEED_TURNS 的用户话,模型自己回),看会不会一轮比一轮多。
  e: 'e2e 测试:回我一句简短的话就行。',
}

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
interface Ledger { replies: string[]; tools: string[]; modelCalls: number; dropped: string[] }
const newLedger = (): Ledger => ({ replies: [], tools: [], modelCalls: 0, dropped: [] })

function fakeInternalApi(ledger: () => Ledger): InternalApiClient {
  let n = 0
  return {
    async request<T>(_method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
      const b = (body ?? {}) as Record<string, unknown>
      if (path === '/v1/wechat/reply' || path === '/v1/wechat/reply_voice') {
        ledger().replies.push(String(b.text ?? ''))
        return { ok: true, msg_id: `sent:${++n}` } as T
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

async function fakeWechatMcpClient(ledger: () => Ledger): Promise<McpClientLike> {
  const api = fakeInternalApi(ledger)
  const server = new McpServer({ name: 'wechat-mcp-fake', version: '0.0.0' }, { capabilities: { tools: {} } })
  registerMemoryTools(server, api)
  registerProjectTools(server, api)
  registerVoiceShareTools(server, api)
  registerMessagingTools(server, api)
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
const META_RE = /停|不再发|不发了|多发|又多了|就到这|打住|收手|结束了|不说了/

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
      if (state.script) return scriptedStep(state.script)
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
  })
  if (arm !== 'ii_prompt') return p
  const bubble = bubbleRepliesSection()
  return p.replace(bubble, `${bubble}\n\n${II_PROMPT_LINE}`)
}

const inbound = (text: string, ms = Date.now()) => formatInbound({ chatId: CHAT_ID, userId: CHAT_ID, userName: '主人', accountId: 'bot-demo', msgType: 'text', text, createTimeMs: ms })

// ─── 一次运行 ────────────────────────────────────────────────────────────
export interface RunResult {
  arm: Arm; scenario: Scenario; run: number
  replies: string[]; nonReplyTools: string[]; steps: number; modelCalls: number
  cleanEnd: boolean; error?: string; dropped: string[]; assistantText: string; ms: number
  /** 只有场景 e:前三轮(真模型)各自的 reply 条数与非 reply 工具。 */
  warmup?: { replies: string[]; nonReplyTools: string[]; dropped: string[] }[]
}

async function runOnce(arm: Arm, scenario: Scenario, run: number, gw: ReturnType<typeof gatewayConfig>): Promise<RunResult> {
  let ledger = newLedger()
  const cur = () => ledger
  const real = createAiSdkChatModel({ baseURL: gw.baseURL, apiKey: gw.apiKey, model: gw.model })
  const h = wrapModel(real, arm, cur)
  const opts: HarnessProviderOptions = {
    makeChatModel: () => h.model,
    makeMcpBridge: async () => createMcpToolBridge({ wechat: { command: 'unused' } as any }, { makeClient: async () => fakeWechatMcpClient(cur) }),
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
      const evs = await drain(inbound(s.user, t0)); t0 += 60_000
      const tools = evs.filter((e): e is Extract<AgentEvent, { kind: 'tool_call' }> => e.kind === 'tool_call').map(e => e.tool)
      warmup.push({ replies: ledger.replies, nonReplyTools: tools.filter(t => !REPLY_FAMILY.has(t)), dropped: ledger.dropped })
    }
  }
  let prompt = inbound(SCENARIO_PROMPT[scenario])
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
  const evs = await drain(prompt)
  await session.close()
  const toolEvents = evs.filter((e): e is Extract<AgentEvent, { kind: 'tool_call' }> => e.kind === 'tool_call').map(e => e.tool)
  const err = evs.find(e => e.kind === 'error') as any
  const finish = evs.find(e => e.kind === 'result') as any
  return {
    arm, scenario, run,
    replies: ledger.replies,
    nonReplyTools: toolEvents.filter(t => !REPLY_FAMILY.has(t)),
    steps: finish?.numTurns ?? ledger.modelCalls,
    modelCalls: ledger.modelCalls,
    cleanEnd: !err,
    ...(err ? { error: String(err.code ?? err.message ?? 'error') } : {}),
    dropped: ledger.dropped,
    assistantText: evs.filter(e => e.kind === 'text').map((e: any) => e.text).join('\n').slice(0, 300),
    ms: Date.now() - start,
    ...(warmup.length ? { warmup } : {}),
  }
}

// ─── 汇总 ────────────────────────────────────────────────────────────────
export function summarize(rows: RunResult[]): string {
  const key = (r: RunResult) => `${r.arm}|${r.scenario}`
  const groups = new Map<string, RunResult[]>()
  for (const r of rows) groups.set(key(r), [...(groups.get(key(r)) ?? []), r])
  const lines = ['| arm | 场景 | n | reply/轮 (各次) | 元话语 reply | 非 reply 工具 | 步数均值 | 干净结束 | 纯文字回落 |', '|---|---|---|---|---|---|---|---|---|']
  for (const [k, rs] of [...groups].sort()) {
    const [arm, sc] = k.split('|')
    const per = rs.map(r => r.replies.length)
    const warm = rs.some(r => r.warmup) ? ` 〔逐轮 ${rs.map(r => [...(r.warmup ?? []).map(w => w.replies.length), r.replies.length].join('→')).join(' / ')}〕` : ''
    const warmTools = rs.flatMap(r => (r.warmup ?? []).flatMap(w => w.nonReplyTools))
    const meta = rs.reduce((a, r) => a + r.replies.filter(t => META_RE.test(t)).length, 0)
    const tools = [...rs.flatMap(r => r.nonReplyTools), ...warmTools]
    const toolStr = tools.length === 0 ? '0' : `${tools.length} (${[...new Set(tools)].join(',')})`
    const steps = (rs.reduce((a, r) => a + r.steps, 0) / rs.length).toFixed(1)
    const clean = rs.filter(r => r.cleanEnd).length
    // 没调 reply、只吐了文字 ⇒ 走 daemon 的 FALLBACK_REPLY(用户收得到,但算异常)
    const fallback = rs.filter(r => r.replies.length === 0 && r.assistantText.trim().length > 0).length
    lines.push(`| ${arm} | ${sc} | ${rs.length} | ${(per.reduce((a, b) => a + b, 0) / rs.length).toFixed(1)} (${per.join(',')})${warm} | ${meta} | ${toolStr} | ${steps} | ${clean}/${rs.length} | ${fallback} |`)
  }
  return lines.join('\n')
}

async function main() {
  const args = process.argv.slice(2)
  const get = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined }
  const sumFile = get('--summarize')
  if (sumFile) {
    const rows = readFileSync(sumFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as RunResult)
    console.log(summarize(rows))
    return
  }
  const arm = (get('--arm') ?? 'baseline') as Arm
  const scenarios = (get('--scenarios') ?? 'a,b,c,d').split(',') as Scenario[]
  const runs = Number(get('--runs') ?? '5')
  const out = get('--out') ?? join(STATE_DIR, 'results.jsonl')
  assertProviderSeams(arm)
  const gw = gatewayConfig()
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
      console.error(`  ${sc}#${r}: replies=${res.replies.length} ${JSON.stringify(res.replies)} tools=${JSON.stringify(res.nonReplyTools)} steps=${res.steps} ${res.error ?? 'ok'}${res.dropped.length ? ` dropped=${JSON.stringify(res.dropped)}` : ''}`)
    }
  }
  console.log(summarize(rows))
}

if (import.meta.main) await main()
