/**
 * 回复交付第 4 步(Codex → daemon):Codex 的「双发旁白 / 吞话」在 daemon 模式下**结构性**消失的证明。
 *
 * Codex 对话侧每一轮是一次 `codex exec`(SDK runStreamed),助理消息是整条的 agent_message;真 codex 调工具之前
 * 习惯先写一句开场(「我查一下当前登记的项目。」),legacy 下 reply 之后再收一条空消息(2026-10-03 沙盒真跑录到)。
 * legacy 下协调器靠 mcp_tool_call 的 server / tool 认 reply:
 *   - 认出来 ⇒ 这一轮文字全丢(只有 reply 工具发的那句);
 *   - 认不出(用户的 codex CLI 比 SDK 新、MCP 调用换了 item 类型 / server 名)⇒ FALLBACK_REPLY 把每一条
 *     agent_message 各发一条 —— 开场这句旁白跟着进了微信(双发);
 *   - 认得出、但 daemon 跑在 strict(没有 bypass)⇒ codex 拒掉每一次 MCP 调用(「user cancelled MCP tool call」),
 *     reply 照样算「回过了」⇒ 模型改用文字说的正文被整轮丢掉,主人一个字都收不到。
 *
 * daemon 模式下说话只有一条路:编码型执行者取**最后一段**非空文字(= 最后一条 agent_message;工具类 item 都是
 * 边界,见 codexItemToolCall),之前的段是旁白(不进微信;超过 120 秒发一句进度)。协调器不再看 tool_call 认不认得出来。
 *
 * 事件走**生产的** Codex provider(createCodexAgentProvider 的事件翻译),对面是照 codex exec 事件形状演的假 Codex
 * (codex-scripted.ts),外加回放 2026-10-03 沙盒真跑录到的流;交付走真的 daemon 交付运行时(只把 sendText 换成记账)。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { createConversationCoordinator, type ConversationCoordinatorDeps, type TurnRecord } from './conversation-coordinator'
import { createProviderRegistry } from './provider-registry'
import { createCodexAgentProvider } from './codex-agent-provider'
import { createScriptedCodex, type CodexScriptedTurn, type CodexScriptedCall, type CodexScriptStep } from './codex-scripted'
import { TIER_PROFILES } from './user-tier'
import type { Mode } from './conversation'
import type { InboundMsg } from './prompt-format'
import type { PermissionMode } from './agent-provider'
import type { ReplyDeliveryMode, TurnReply } from './turn-reply'
import { makeReplyDeliveryRuntime } from '../daemon/reply-delivery'

const CHAT = 'chat-1'

interface RigOpts {
  turns: CodexScriptedTurn[]
  mode: ReplyDeliveryMode
  permissionMode?: PermissionMode
  mcpItem?: 'mcp_tool_call' | 'unknown_item'
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
  // MCP server 那一侧:legacy 的 reply / reply_voice 路由把话发进微信;daemon 的附件工具(不带 chat_id,会话令牌认聊天)挂到本轮。
  const onToolCall = async (call: CodexScriptedCall) => {
    if (call.tool === 'reply') wechat.push(String(call.args.text))
    else if (call.tool === 'reply_voice') wechat.push(`[语音] ${String(call.args.text)}`)
    else if (call.tool === 'voice') rt.attach(CHAT, { attachment: { kind: 'voice', text: String(call.args.text) }, send: async () => { wechat.push(`[语音] ${String(call.args.text)}`); return { ok: true } } })
  }
  const permissionMode = o.permissionMode ?? 'dangerously'
  const scripted = createScriptedCodex({ turns: o.turns, onToolCall, ...(o.mcpItem ? { mcpItem: o.mcpItem } : {}) })
  // 和 providers.ts 一样:--dangerously ⇒ bypass(MCP 调用才放得过);strict ⇒ 不带。
  const provider = createCodexAgentProvider({ codexFactory: scripted.factory, dangerouslyBypassApprovalsAndSandbox: permissionMode === 'dangerously', timeouts: { firstEventTimeoutMs: 5_000, connectTimeoutMs: 5_000 } })
  const registry = createProviderRegistry()
  registry.register('codex', provider, { displayName: 'Codex', canResume: () => true })
  const data = new Map<string, { mode: Mode }>([[CHAT, { mode: { kind: 'solo', provider: 'codex' } }]])
  let live: Awaited<ReturnType<typeof provider.spawn>> | undefined
  const c = createConversationCoordinator({
    resolveProject: () => ({ alias: 'a', path: '/p' }),
    manager: {
      // 同一个会话(同一个 codex thread)连跑多轮:每轮一次 runStreamed,和生产的 session manager 一样复用。
      acquire: vi.fn(async () => {
        if (!live) live = await provider.spawn({ alias: 'a', path: '/p' }, { tierProfile: TIER_PROFILES.admin, permissionMode, chatId: CHAT })
        const s = live
        return { alias: 'a', path: '/p', providerId: 'codex', lastUsedAt: 0, dispatch: (t: string) => s.dispatch(t), cancel: async () => { await s.cancel?.() }, close: async () => {} }
      }),
      release: vi.fn(async () => {}),
    } as unknown as ConversationCoordinatorDeps['manager'],
    conversationStore: { get: (id: string) => data.get(id) ?? null, set: vi.fn(), setParticipants: vi.fn() },
    registry,
    defaultProviderId: 'codex',
    format: (m) => m.text,
    permissionMode,
    loadAccess: () => ({ dmPolicy: 'allowlist', allowFrom: [], admins: [CHAT] }),
    log: (tag, l) => { logs.push(`[${tag}] ${l}`) },
    sendAssistantText: async (_c, t) => { wechat.push(t) },
    sendNotice: async (_c, t) => { notices.push(t) },
    recordTurn: (r) => { records.push(r) },
    replyDelivery: rt,
    replyDeliveryModeFor: () => o.mode,
    ...(o.progressAfterMs !== undefined ? { replyProgressAfterMs: o.progressAfterMs } : {}),
  })
  const send = (text = '你好') => c.dispatch({ chatId: CHAT, userId: CHAT, text, msgType: 'text', createTimeMs: Date.now(), accountId: 'acct' } as InboundMsg)
  const close = async () => { await live?.close() }
  return { send, close, wechat, notices, logs, records, captured, scripted }
}

const say = (s: string): CodexScriptStep => ({ say: s })
const mcp = (tool: string, args: Record<string, unknown> = {}, ifRejected?: CodexScriptStep[]): CodexScriptStep =>
  ({ mcp: { server: 'wechat', tool, args }, ...(ifRejected ? { ifRejected } : {}) })

const ANSWER = '你现在有两个项目:wechat-cc 和 blog。'
/**
 * legacy:照今天的提示词,正文经 reply 说出去(被拒就改用文字说)。形状照 2026-10-03 沙盒真跑录到的:
 * 调工具前先写一句开场,reply 之后照例再收一条**空的** agent_message(见下面的回放 legacy-d1)。
 */
const legacyTurn = (): CodexScriptedTurn => ({ steps: [
  { think: '用户问项目' }, say('我先看一下项目列表。'), mcp('list_projects'),
  mcp('reply', { chat_id: CHAT, text: ANSWER }, [say(`reply 工具被拒了,直接说:${ANSWER}`)]),
  say(''),
] })
const daemonTurn = (): CodexScriptedTurn => ({ steps: [
  { think: '用户问项目' }, say('我先看一下项目列表。'), mcp('list_projects'), say(ANSWER),
] })

describe('Codex:双发旁白 / 吞话在 daemon 模式下结构性消失(生产的 Codex provider + codex exec 事件形状)', () => {
  it('legacy(对照):mcp_tool_call 照 SDK 形状、--dangerously ⇒ reply 认得出,只有 reply 的那句', async () => {
    const t = rig({ turns: [legacyTurn()], mode: 'legacy' })
    await t.send(); await t.close()
    expect(t.wechat).toEqual([ANSWER])
    expect(t.logs.some(l => l.startsWith('[FALLBACK_REPLY]'))).toBe(false)
  })

  it('legacy(复现根因):CLI 比 SDK 新、MCP 调用换了 item 类型 ⇒ 认不出 reply ⇒ FALLBACK_REPLY 把旁白一条一条发出去(双发)', async () => {
    const t = rig({ turns: [legacyTurn()], mode: 'legacy', mcpItem: 'unknown_item' })
    await t.send(); await t.close()
    expect(t.logs.some(l => l.startsWith('[FALLBACK_REPLY]'))).toBe(true)
    // reply 工具已经发了一次正文,FALLBACK 再把开场「我先看一下项目列表。」当回复发一条。
    expect(t.wechat).toEqual([ANSWER, '我先看一下项目列表。'])
  })

  it('legacy(复现根因):strict(没有 bypass)⇒ codex 拒掉 reply,调用照样算「回过了」⇒ 改用文字说的正文整轮丢掉', async () => {
    const t = rig({ turns: [legacyTurn()], mode: 'legacy', permissionMode: 'strict' })
    await t.send(); await t.close()
    expect(t.wechat).toEqual([])
    expect(t.logs.some(l => l.startsWith('[FALLBACK_REPLY]'))).toBe(false)
  })

  it('daemon:只交付最后一段,一次;没有 FALLBACK_REPLY;item 形状 / strict 与否,交付一字不差', async () => {
    const outcomes: string[][] = []
    for (const [mcpItem, pm] of [['mcp_tool_call', 'dangerously'], ['unknown_item', 'dangerously'], ['mcp_tool_call', 'strict']] as const) {
      const t = rig({ turns: [daemonTurn()], mode: 'daemon', mcpItem, permissionMode: pm })
      await t.send(); await t.close()
      expect(t.logs.some(l => l.startsWith('[FALLBACK_REPLY]'))).toBe(false)
      expect(t.records[0]).toMatchObject({ provider: 'codex', outcome: 'completed', delivery: 'text', bubbles: 1, narrationSegments: 1, replyToolCalled: false })
      outcomes.push(t.wechat)
    }
    for (const o of outcomes) expect(o).toEqual([ANSWER])
  })

  it('daemon:旁白 → shell → 结论(以前 shell 不产 tool_call,两条消息粘成一段)⇒ 只交付结论', async () => {
    const t = rig({ turns: [{ steps: [say('我先跑个命令看看 git 状态。'), { shell: 'git status --short', output: '' }, say('工作区是干净的,没有未提交的改动。')] }], mode: 'daemon' })
    await t.send(); await t.close()
    expect(t.wechat).toEqual(['工作区是干净的,没有未提交的改动。'])
    expect(t.records[0]).toMatchObject({ toolCalls: ['shell'], narrationSegments: 1 })
  })

  it('daemon:同一个 thread 连跑四轮,每轮恰好一条;系统指令只在第一轮前置', async () => {
    const turns = ['在的。', '收到。', '好的,只回一句。', '嗯。'].map(a => ({ steps: [{ think: 'x' }, say(a)] }))
    const t = rig({ turns, mode: 'daemon' })
    for (let i = 0; i < 4; i++) await t.send(`第 ${i + 1} 轮`)
    await t.close()
    expect(t.wechat).toEqual(['在的。', '收到。', '好的,只回一句。', '嗯。'])
    expect(t.records.map(r => r.bubbles)).toEqual([1, 1, 1, 1])
    // 一个 thread(只 startThread 一次),四次 runStreamed。
    expect(t.scripted.threadOptions).toHaveLength(1)
    expect(t.scripted.inputs).toHaveLength(4)
  })

  it('daemon:语音是本轮的附件(工具没有 chat_id),文字之后发', async () => {
    const t = rig({ turns: [{ steps: [mcp('voice', { text: '晚安,早点休息。' }), say('晚安~')] }], mode: 'daemon' })
    await t.send('用语音说晚安'); await t.close()
    expect(t.wechat).toEqual(['晚安~', '[语音] 晚安,早点休息。'])
    expect(t.records[0]).toMatchObject({ delivery: 'text', attachments: 1 })
  })

  it('daemon:长任务超过进度阈值 ⇒ 只发一次进度(最近一段旁白),之后最后的话照常一条', async () => {
    const t = rig({ turns: [{ steps: [say('我先看一下项目列表。'), mcp('list_projects'), { delayMs: 60 }, say('再翻翻记忆。'), mcp('memory_read', { path: 'profile.md' }), { delayMs: 60 }, say(ANSWER)] }], mode: 'daemon', progressAfterMs: 30 })
    await t.send(); await t.close()
    expect(t.wechat).toEqual(['我先看一下项目列表。', ANSWER])
    expect(t.logs.filter(l => l.startsWith('[REPLY_PROGRESS]'))).toHaveLength(1)
  })

  it('daemon:app 这一轮 ⇒ 整个 TurnReply(含旁白)交给接收器,一个字都不进微信,也不发进度', async () => {
    const t = rig({ turns: [{ steps: [say('我先看一下项目列表。'), mcp('list_projects'), { delayMs: 40 }, say(ANSWER)] }], mode: 'daemon', sink: true, progressAfterMs: 10 })
    await t.send(); await t.close()
    expect(t.wechat).toEqual([])
    expect(t.captured).toHaveLength(1)
    expect(t.captured[0]).toMatchObject({ text: ANSWER, narration: ['我先看一下项目列表。'] })
    expect(t.records[0]).toMatchObject({ delivery: 'text' })
  })

  it('daemon:私聊里写 NO_REPLY ⇒ 令牌不外泄,记 REPLY_SILENT_IN_DM;legacy 同样的输出会被 FALLBACK 原样发出去', async () => {
    const d = rig({ turns: [{ steps: [say('NO_REPLY')] }], mode: 'daemon' })
    await d.send('不用回我了'); await d.close()
    expect(d.wechat).toEqual([])
    expect(d.logs.some(l => l.startsWith('[REPLY_SILENT_IN_DM]'))).toBe(true)
    const l = rig({ turns: [{ steps: [say('NO_REPLY')] }], mode: 'legacy' })
    await l.send('不用回我了'); await l.close()
    expect(l.wechat).toEqual(['NO_REPLY'])
  })

  it('daemon:出错的轮(说了半句后 turn.failed)⇒ 只发通知,半句不交付;码照 #197 由边界产', async () => {
    const t = rig({ turns: [{ steps: [say('我先看一下。')], fail: 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header' }], mode: 'daemon' })
    await t.send(); await t.close()
    expect(t.wechat).toEqual([])
    expect(t.records[0]).toMatchObject({ outcome: 'auth_failed', errorCode: 'auth_failed' })
    const u = rig({ turns: [{ steps: [say('我先看一下。')], fail: "You've hit your usage limit. Upgrade to Pro" }], mode: 'daemon' })
    await u.send(); await u.close()
    expect(u.wechat).toEqual([])
    expect(u.notices).toHaveLength(1)
    expect(u.records[0]).toMatchObject({ outcome: 'error' })
    expect(u.notices[0]).not.toContain('我先看一下')
  })
})

// ─── 回放 2026-10-03 沙盒真跑录到的 codex exec 事件流 ──────────────────────────────
type Obj = Record<string, any>
const FIXTURE = fileURLToPath(new URL('./fixtures/codex-exec-2026-10-03.jsonl', import.meta.url))
const rows = readFileSync(FIXTURE, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as Obj)
/** 一个录到的回合:原样当剧本(只取 item.* 事件;thread.started / turn.* 由假 Codex 自己发)。 */
function recordedTurn(id: string): CodexScriptedTurn {
  const r = rows.find(x => x.id === id)
  if (!r) throw new Error(`fixture 里没有 ${id}`)
  return { steps: (r.events as Obj[]).filter(e => String(e.type).startsWith('item.')).map(e => ({ raw: e })) }
}

/** 录到的一轮里非空的 agent_message(按顺序,去掉首尾空白)。 */
function messagesOf(id: string): string[] {
  const r = rows.find(x => x.id === id)!
  return (r.events as Obj[]).filter(e => e.type === 'item.completed' && e.item.type === 'agent_message').map(e => String(e.item.text).trim()).filter(Boolean)
}
async function replay(id: string, mode: ReplyDeliveryMode) {
  const t = rig({ turns: [recordedTurn(id)], mode })
  await t.send(); await t.close()
  return t
}

// 回放里 MCP 调用是录下来的 item,不再经 onToolCall 发进微信 —— legacy 这里只看协调器自己会发什么(FALLBACK 那一部分)。
describe('Codex:回放沙盒真跑录到的流(真 codex 0.153.4 + gpt-6-astra,2026-10-03)', () => {
  it('fixture 里六轮都在,来自真 codex(不是剧本)', () => {
    expect(rows.map(r => r.id)).toEqual(['daemon-d1', 'daemon-h1', 'daemon-f-strict', 'daemon-i1', 'legacy-a-strict', 'legacy-d1'])
    for (const r of rows) expect((r.events as Obj[])[0]).toMatchObject({ type: 'thread.started' })
  })

  for (const id of ['daemon-d1', 'daemon-h1', 'daemon-f-strict']) {
    it(`${id}:真 codex 调工具前先写一句开场 —— daemon 只交付最后一条消息;同一条流走 legacy,FALLBACK 把开场也发出去`, async () => {
      const m = messagesOf(id)
      expect(m.length).toBe(2)
      const d = await replay(id, 'daemon')
      expect(d.wechat.join('\n\n')).toBe(m[1])
      expect(d.records[0]).toMatchObject({ outcome: 'completed', delivery: 'text', narrationSegments: 1 })
      expect(d.logs.some(l => l.startsWith('[FALLBACK_REPLY]'))).toBe(false)
      const l = await replay(id, 'legacy')
      expect(l.wechat.map(t => t.trim())).toEqual(m)
    })
  }

  it('daemon-i1:私聊「不用回」时真 codex 写了一条空消息 ⇒ 什么都不发,记 delivery=empty(计入「应答轮交付为空」)', async () => {
    const d = await replay('daemon-i1', 'daemon')
    expect(d.wechat).toEqual([])
    expect(d.records[0]).toMatchObject({ outcome: 'completed', delivery: 'empty' })
  })

  it('legacy-a-strict:真机复现「strict 吞话」—— reply 被 codex 拒掉,模型改用文字说,legacy 一个字都不发;同一条流 daemon 交付那句话', async () => {
    const m = messagesOf('legacy-a-strict')
    const failed = (rows.find(r => r.id === 'legacy-a-strict')!.events as Obj[]).find(e => e.type === 'item.completed' && e.item.tool === 'reply')
    expect(failed?.item).toMatchObject({ status: 'failed', error: { message: 'MCP tool call requires approval, but approval policy is never' } })
    const l = await replay('legacy-a-strict', 'legacy')
    expect(l.wechat).toEqual([])
    const d = await replay('legacy-a-strict', 'daemon')
    expect(d.wechat.join('\n\n')).toBe(m[m.length - 1])
  })

  it('legacy-d1:legacy 正常路径 —— 开场 → 工具 → reply → 空的最后一条;reply 认得出,协调器自己不再发任何字', async () => {
    const l = await replay('legacy-d1', 'legacy')
    expect(l.wechat).toEqual([])
    expect(l.records[0]).toMatchObject({ replyToolCalled: true })
  })
})
