/**
 * 回复交付第 5 步(Claude → daemon):Claude 的「双发旁白 / 吞话」在 daemon 模式下**结构性**消失的证明。
 *
 * Claude 对话侧是一个常驻的 Agent SDK `query()`;旧路(legacy,D3 已删,对照臂随之删掉)下协调器靠 tool_use 的名字
 * (`mcp__wechat__reply`)认 reply:
 *   - 认出来 ⇒ 这一轮文字全丢(只有 reply 工具发的那句);
 *   - 认不出(wechat MCP 挂在别的名字下,比如 Claude Code 插件 MCP 的 `mcp__plugin_<插件>_<server>__reply`)⇒
 *     FALLBACK_REPLY 把每段文字各发一条 —— 「我先看一下」这句旁白跟着进了微信(双发);
 *   - 认得出、但 reply 调用失败了(MCP 起不来 / 内部 API 拒了)⇒ 照样算「回过了」⇒ 模型改用文字说的正文被整轮丢掉。
 *
 * daemon 模式下说话只有一条路:编码型执行者取**最后一段**非空文字,之前的段是旁白。provider 侧两处修正(spec §4.2
 * Claude 行):① 事件按块的顺序发(以前同一条消息里先发 tool_call 再发文字,`bundled` 形状下开场被算进工具之后的段);
 * ② 子 agent(parent_tool_use_id)的文字不进任何一段。SDK 的 `result.result` 只用来核对(对不上记 REPLY_FINAL_CHECK)。
 *
 * 事件走**生产的** Claude provider(createClaudeAgentProvider 的消息翻译),对面是照 SDK 消息形状演的假 `query()`
 * (claude-scripted.ts);交付走真的 daemon 交付运行时(只把 sendText 换成记账)。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { createConversationCoordinator, type ConversationCoordinatorDeps, type TurnRecord } from './conversation-coordinator'
import { createProviderRegistry } from './provider-registry'
import { createClaudeAgentProvider } from '../adapters/executors/claude/claude-agent-provider'
import { createScriptedClaude, type ClaudeScriptedCall, type ClaudeScriptedTurn, type ClaudeScriptStep, type ClaudeShape } from '../test-support/executors/claude-scripted'
import { TIER_PROFILES } from '../domain/user-tier'
import type { Mode } from '../domain/conversation'
import type { InboundMsg } from '../domain/prompt-format'
import type { TurnReply } from '../domain/turn-reply'
import { makeReplyDeliveryRuntime } from '../daemon/reply-delivery'

const CHAT = 'chat-1'

interface RigOpts {
  turns: ClaudeScriptedTurn[]
  shape?: ClaudeShape
  sink?: boolean
  progressAfterMs?: number
}

function rig(o: RigOpts) {
  const wechat: string[] = []
  const notices: string[] = []
  const logs: string[] = []
  const records: TurnRecord[] = []
  const captured: TurnReply[] = []
  const rt = makeReplyDeliveryRuntime({
    sendText: async (_c, t) => { wechat.push(t); return { msgId: `m${wechat.length}` } },
    sleep: async () => {},
    log: (tag, line) => { logs.push(`[${tag}] ${line}`) },
    ...(o.sink ? { sink: { captureReply: (_c: string, r: TurnReply) => { captured.push(r); return true } }, isSinkOpen: () => true } : {}),
  })
  // MCP server 那一侧:附件工具(不带 chat_id,会话令牌认聊天)挂到本轮。
  const onToolCall = async (call: ClaudeScriptedCall) => {
    if (call.server !== 'wechat') return
    if (call.tool === 'voice') rt.attach(CHAT, { attachment: { kind: 'voice', text: String(call.args.text) }, send: async () => { wechat.push(`[语音] ${String(call.args.text)}`); return { ok: true } } })
  }
  const scripted = createScriptedClaude({ turns: o.turns, onToolCall, shape: o.shape ?? 'recorded' })
  const provider = createClaudeAgentProvider({ sdkOptionsForProject: () => ({}), queryImpl: scripted.query })
  const registry = createProviderRegistry()
  registry.register('claude', provider, { displayName: 'Claude', canResume: () => true })
  const data = new Map<string, { mode: Mode }>([[CHAT, { mode: { kind: 'solo', provider: 'claude' } }]])
  let live: Awaited<ReturnType<typeof provider.spawn>> | undefined
  const c = createConversationCoordinator({
    resolveProject: () => ({ alias: 'a', path: '/p' }),
    manager: {
      // 同一个常驻会话连跑多轮,和生产的 session manager 一样复用。
      acquire: vi.fn(async () => {
        if (!live) live = await provider.spawn({ alias: 'a', path: '/p' }, { tierProfile: TIER_PROFILES.admin, permissionMode: 'dangerously', chatId: CHAT })
        const s = live
        return { alias: 'a', path: '/p', providerId: 'claude', lastUsedAt: 0, dispatch: (t: string) => s.dispatch(t), cancel: async () => { await s.cancel?.() }, close: async () => {} }
      }),
      release: vi.fn(async () => {}),
    } as unknown as ConversationCoordinatorDeps['manager'],
    conversationStore: { get: (id: string) => data.get(id) ?? null, set: vi.fn(), setParticipants: vi.fn() },
    registry,
    defaultProviderId: 'claude',
    format: (m) => m.text,
    permissionMode: 'dangerously',
    loadAccess: () => ({ dmPolicy: 'allowlist', allowFrom: [], admins: [CHAT] }),
    log: (tag, l) => { logs.push(`[${tag}] ${l}`) },
    sendAssistantText: async (_c, t) => { wechat.push(t) },
    sendNotice: async (_c, t) => { notices.push(t) },
    recordTurn: (r) => { records.push(r) },
    replyDelivery: rt,
    ...(o.progressAfterMs !== undefined ? { replyProgressAfterMs: o.progressAfterMs } : {}),
  })
  const send = (text = '你好') => c.dispatch({ chatId: CHAT, userId: CHAT, text, msgType: 'text', createTimeMs: Date.now(), accountId: 'acct' } as InboundMsg)
  const close = async () => { await live?.close() }
  return { send, close, wechat, notices, logs, records, captured, scripted }
}

const say = (s: string): ClaudeScriptStep => ({ say: s })
const wx = (tool: string, args: Record<string, unknown> = {}, ifError?: ClaudeScriptStep[]): ClaudeScriptStep =>
  ({ tool, server: 'wechat', args, ...(ifError ? { ifError } : {}) })

const OPENING = '我先看一下项目列表。'
const ANSWER = '你现在有两个项目:wechat-cc 和 blog。'
const daemonTurn = (): ClaudeScriptedTurn => ({ steps: [{ think: '用户问项目' }, say(OPENING), wx('list_projects'), say(ANSWER)] })

describe('Claude:双发旁白 / 吞话在 daemon 模式下结构性消失(生产的 Claude provider + Agent SDK 消息形状)', () => {

  it('daemon:只交付最后一段,一次;没有 FALLBACK_REPLY;四种外部条件交付一字不差;result.result 与分段一致', async () => {
    for (const shape of ['recorded', 'bundled', 'drift', 'tool_error'] as const) {
      const t = rig({ turns: [daemonTurn()], shape })
      await t.send(); await t.close()
      expect(t.wechat, shape).toEqual([ANSWER])
      expect(t.logs.some(l => l.startsWith('[FALLBACK_REPLY]'))).toBe(false)
      expect(t.logs.some(l => l.startsWith('[REPLY_FINAL_CHECK]')), shape).toBe(false)
      expect(t.records[0]).toMatchObject({ provider: 'claude', outcome: 'completed', delivery: 'text', bubbles: 1, narrationSegments: 1, replyToolCalled: false })
    }
  })

  it('daemon + bundled:同一条消息里「开场 + tool_use」,下一条是结论 ⇒ 开场是旁白(以前先发 tool_call 再发文字,开场和结论粘成一段)', async () => {
    const t = rig({ turns: [{ steps: [say(OPENING), wx('list_projects'), wx('memory_list'), say('再翻翻记忆。'), wx('memory_read', { path: 'profile.md' }), say(ANSWER)] }], shape: 'bundled' })
    await t.send(); await t.close()
    expect(t.wechat).toEqual([ANSWER])
    expect(t.records[0]).toMatchObject({ narrationSegments: 2, toolCalls: ['wechat/list_projects', 'wechat/memory_list', 'wechat/memory_read'] })
  })

  it('daemon:子 agent(Task)里的过程文字不进最后的话,也不算旁白;最后的话是主 agent 的总结', async () => {
    const t = rig({ turns: [{ steps: [say('我让子 agent 去查一下。'), { subagent: [say('子 agent:开始搜索 src/。'), { tool: 'Grep', args: { pattern: 'reply' } }, say('子 agent:找到 3 处。')] }, say('查完了:reply 工具在 3 个地方注册。')] }] })
    await t.send(); await t.close()
    expect(t.wechat).toEqual(['查完了:reply 工具在 3 个地方注册。'])
    expect(t.records[0]).toMatchObject({ narrationSegments: 1 })
  })

  it('daemon:同一个会话连跑四轮,每轮恰好一条', async () => {
    const turns = ['在的。', '收到。', '好的,只回一句。', '嗯。'].map(a => ({ steps: [{ think: 'x' }, say(a)] }))
    const t = rig({ turns })
    for (let i = 0; i < 4; i++) await t.send(`第 ${i + 1} 轮`)
    await t.close()
    expect(t.wechat).toEqual(['在的。', '收到。', '好的,只回一句。', '嗯。'])
    expect(t.records.map(r => r.bubbles)).toEqual([1, 1, 1, 1])
    expect(t.scripted.inputs).toHaveLength(4)
  })

  it('daemon:语音是本轮的附件(工具没有 chat_id),文字之后发;与语音同文 ⇒ 只发语音', async () => {
    const t = rig({ turns: [{ steps: [wx('voice', { text: '晚安,早点休息。' }), say('晚安~')] }] })
    await t.send('用语音说晚安'); await t.close()
    expect(t.wechat).toEqual(['晚安~', '[语音] 晚安,早点休息。'])
    expect(t.records[0]).toMatchObject({ delivery: 'text', attachments: 1 })
    const same = rig({ turns: [{ steps: [wx('voice', { text: '晚安,早点休息。' }), say('晚安,早点休息。')] }] })
    await same.send('用语音说晚安'); await same.close()
    expect(same.wechat).toEqual(['[语音] 晚安,早点休息。'])
  })

  it('daemon:长任务超过进度阈值 ⇒ 只发一次进度(最近一段旁白),之后最后的话照常一条', async () => {
    const t = rig({ turns: [{ steps: [say(OPENING), wx('list_projects'), { delayMs: 60 }, say('再翻翻记忆。'), wx('memory_read', { path: 'profile.md' }), { delayMs: 60 }, say(ANSWER)] }], progressAfterMs: 30 })
    await t.send(); await t.close()
    expect(t.wechat).toEqual([OPENING, ANSWER])
    expect(t.logs.filter(l => l.startsWith('[REPLY_PROGRESS]'))).toHaveLength(1)
  })

  it('daemon:app 这一轮 ⇒ 整个 TurnReply(含旁白)交给接收器,一个字都不进微信,也不发进度', async () => {
    const t = rig({ turns: [{ steps: [say(OPENING), wx('list_projects'), { delayMs: 40 }, say(ANSWER)] }], sink: true, progressAfterMs: 10 })
    await t.send(); await t.close()
    expect(t.wechat).toEqual([])
    expect(t.captured).toHaveLength(1)
    expect(t.captured[0]).toMatchObject({ text: ANSWER, narration: [OPENING] })
    expect(t.records[0]).toMatchObject({ delivery: 'text' })
  })

  it('daemon:私聊里写 NO_REPLY ⇒ 令牌不外泄,记 REPLY_SILENT_IN_DM', async () => {
    const d = rig({ turns: [{ steps: [say('NO_REPLY')] }] })
    await d.send('不用回我了'); await d.close()
    expect(d.wechat).toEqual([])
    expect(d.logs.some(l => l.startsWith('[REPLY_SILENT_IN_DM]'))).toBe(true)
  })

  it('daemon:SDK 标注的 API 错误(#190 的真实形状)⇒ 只发通知,错误原文一个字都不交付', async () => {
    const t = rig({ turns: [{ steps: [], apiError: { sdkError: 'authentication_failed', text: 'Failed to authenticate. API Error: 403 Request not allowed', status: 403 } }] })
    await t.send(); await t.close()
    expect(t.wechat).toEqual([])
    expect(t.notices).toHaveLength(1)
    expect(t.notices[0]).not.toContain('Request not allowed') // 受控文案(「认证没通过…」),不是原文
    expect(t.records[0]).toMatchObject({ errorCode: 'auth_rejected' })
  })

  it('daemon:说了半句之后才出 API 错误 ⇒ 半句不交付,只发通知', async () => {
    const t = rig({ turns: [{ steps: [say('我先看一下。'), wx('list_projects'), { raw: { type: 'assistant', parent_tool_use_id: null, error: 'server_error', message: { content: [{ type: 'text', text: 'API Error: Connection refused (ECONNREFUSED)' }] } } }, { raw: { type: 'result', subtype: 'success', session_id: 's', num_turns: 2, duration_ms: 1, is_error: true, api_error_status: null, result: 'API Error: Connection refused (ECONNREFUSED)' } }] }] })
    await t.send(); await t.close()
    expect(t.wechat).toEqual([])
    expect(t.records[0]).toMatchObject({ outcome: 'error', errorCode: 'network' })
    expect(t.notices.join('')).not.toContain('我先看一下')
  })
})

// ─── #190 的 56 条真实错误样本里 Claude 那 14 条:finalText 永远不含错误文案 ─────────────────────
type Sample = { id: string; path: string; message: string; sdkStructure?: Record<string, unknown> }
const FIXTURE = fileURLToPath(new URL('../daemon/diagnostics/__fixtures__/provider-errors/claude.json', import.meta.url))
const samples = (JSON.parse(readFileSync(FIXTURE, 'utf8')) as Sample[]).filter(s => s.sdkStructure)

describe('Claude:#190 的真实错误样本走 daemon ⇒ 一个字都不交付、result 不带 finalText', () => {
  for (const s of samples) {
    it(s.id, async () => {
      const st = s.sdkStructure!
      const text = (st['assistant.text'] as string | undefined) ?? s.message
      const t = rig({ turns: [{ steps: [], apiError: { sdkError: String(st['assistant.error']), text, status: (st['result.api_error_status'] as number | null | undefined) ?? null } }] })
      await t.send(); await t.close()
      expect(t.wechat).toEqual([])
      expect(t.records[0]!.outcome).not.toBe('completed')
      expect(t.notices.join('\n')).not.toContain(text.slice(0, 20))
    })
  }

  it('SDK 只给了 is_error、没有标注的助理消息 ⇒ provider 补一个带码的 error,result.result 不当回复', async () => {
    const leak = 'API Error: 529 Overloaded'
    const t = rig({ turns: [{ steps: [{ raw: { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: leak }] } } }, { raw: { type: 'result', subtype: 'success', session_id: 's', num_turns: 1, duration_ms: 1, is_error: true, api_error_status: 529, result: leak } }] }] })
    await t.send(); await t.close()
    expect(t.wechat).toEqual([])
    expect(t.records[0]).toMatchObject({ outcome: 'error', errorCode: 'provider_error' })
  })
})

// ─── 回放 2026-10-03 沙盒真跑录到的 SDK 消息流(真 Claude Code 2.1.289 + claude-opus-4-8)──────────────────
type Obj = Record<string, any>
const REC = fileURLToPath(new URL('../core/fixtures/claude-sdk-2026-10-03.jsonl', import.meta.url))
const recRows = readFileSync(REC, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as Obj)
const recorded = (id: string): Obj[] => {
  const r = recRows.find(x => x.id === id)
  if (!r) throw new Error(`fixture 里没有 ${id}`)
  return r.messages as Obj[]
}
/** 录到的这一轮的 SDK result.result(= 主 agent 最后一条助理消息的文字)。 */
const resultOf = (id: string): string => String(recorded(id).find(m => m.type === 'result')?.result ?? '')
async function replayClaude(id: string) {
  const msgs = recorded(id)
  const t = rig({ turns: [{ steps: [], replay: msgs }] })
  await t.send(); await t.close()
  return t
}

describe('Claude:回放沙盒真跑录到的流', () => {
  it('fixture 里七轮都在;真 Claude Code 每个内容块单独一条 assistant 消息', () => {
    expect(recRows.map(r => r.id)).toEqual(['daemon-d1', 'daemon-h1', 'daemon-f1', 'daemon-g1', 'legacy-f1', 'legacy-h1', 'legacy-i1'])
    for (const r of recRows) {
      for (const m of r.messages as Obj[]) if (m.type === 'assistant') expect((m.message.content as unknown[]).length).toBe(1)
      expect((r.messages as Obj[]).filter(m => m.type === 'result')).toHaveLength(1)
    }
  })

  for (const id of ['daemon-d1', 'daemon-h1']) {
    it(`${id}:daemon 只交付最后一段,和 SDK 的 result.result 一字不差(没有 REPLY_FINAL_CHECK)`, async () => {
      const d = await replayClaude(id)
      expect(d.wechat.join('\n\n')).toBe(resultOf(id))
      expect(d.records[0]).toMatchObject({ outcome: 'completed', delivery: 'text', replyToolCalled: false })
      expect(d.logs.some(l => l.startsWith('[REPLY_FINAL_CHECK]'))).toBe(false)
    })
  }

  it('daemon-f1:语音(工具调用是录下来的,不经 MCP)之后的最后一句照常交付;g1 推送里写的是 NO_REPLY', async () => {
    const f = await replayClaude('daemon-f1')
    expect(f.wechat).toEqual([resultOf('daemon-f1')])
    expect(resultOf('daemon-g1')).toBe('NO_REPLY')
  })
})
