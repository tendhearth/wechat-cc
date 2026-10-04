/**
 * 回复交付第 3 步(Cursor → daemon):Cursor「双发旁白」在 daemon 模式下**结构性**消失的证明。
 *
 * Cursor(ACP,messages 模式)每遇到一个 tool_call 就把攒着的助理文字冲成一条 text 事件。legacy 下协调器靠
 * tool_call 的 MCP 身份(`rawInput.providerIdentifier / toolName`,只在 tool_call_update 里出现)认 reply:
 *   - 认出来 ⇒ 这一轮文字全丢(只有 reply 工具发的那句);
 *   - 认不出(CLI 换 envelope、身份没带、server 名换了)⇒ FALLBACK_REPLY 把每一段文字各发一条 ——
 *     「正在看…」「已回复。」这些旁白一起进了微信(记忆里 cursor 的老毛病:每轮双发旁白);
 *   - 认得出、但 strict 下 reply 调用被权限卡拒掉 ⇒ 照样算「回过了」⇒ 这一轮一个字都没发出去。
 * 修法一直是「把这一家的 tool_call 形状认对」;下一版 CLI 换个形状,双发就悄悄回来。
 *
 * daemon 模式下说话只有一条路:编码型执行者取**最后一段**非空文字,之前的段是旁白(不进微信;超过 120 秒发一句进度)。
 * 协调器不再看 tool_call 认不认得出来 —— 所以身份带不带、server 名是什么都无所谓。
 *
 * 事件走**生产的** Cursor ACP 客户端(createAcpCursorChatProvider + acp-agent-provider 的 JSON-RPC + acp/events 翻译器),
 * 对面是照 2026-09-17 真机报文形状演的假 `cursor-agent acp`(acp/scripted-agent.ts),外加原样回放录到的报文;
 * 交付走真的 daemon 交付运行时(reply-delivery.ts,只把 sendText 换成记账)。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { createConversationCoordinator, type ConversationCoordinatorDeps, type TurnRecord } from './conversation-coordinator'
import { createProviderRegistry } from './provider-registry'
import { createAcpCursorChatProvider } from './acp-cursor-chat'
import { createScriptedAcpAgent, type ScriptedTurn, type ScriptedToolCall, type ScriptStep } from './acp/scripted-agent'
import { TIER_PROFILES } from './user-tier'
import type { Mode } from './conversation'
import type { InboundMsg } from './prompt-format'
import type { PermissionMode } from './agent-provider'
import type { ReplyDeliveryMode, TurnReply } from './turn-reply'
import { makeReplyDeliveryRuntime } from '../daemon/reply-delivery'

const CHAT = 'chat-1'

interface RigOpts {
  turns: ScriptedTurn[]
  mode: ReplyDeliveryMode
  permissionMode?: PermissionMode
  /** app 接收器开着(桌面 / 手机这一轮)。 */
  sink?: boolean
  progressAfterMs?: number
}

function rig(o: RigOpts) {
  const wechat: string[] = [] // 主人微信上真的出现的每一条(按时间顺序)
  const notices: string[] = []
  const logs: string[] = []
  const records: TurnRecord[] = []
  const captured: TurnReply[] = []
  // MCP server 那一侧:legacy 的 reply / reply_voice 路由把话发进微信;daemon 的附件工具把语音挂到本轮。
  const rt = makeReplyDeliveryRuntime({
    sendText: async (_c, t) => { wechat.push(t); return { msgId: `m${wechat.length}` } },
    sleep: async () => {},
    log: (tag, line) => { logs.push(`[${tag}] ${line}`) },
    ...(o.sink ? { sink: { captureReply: (_c: string, r: TurnReply) => { captured.push(r); return true } }, isSinkOpen: () => true } : {}),
  })
  const onToolCall = async (call: ScriptedToolCall) => {
    if (call.tool === 'reply') wechat.push(String(call.args.text))
    else if (call.tool === 'reply_voice') wechat.push(`[语音] ${String(call.args.text)}`)
    else if (call.tool === 'voice') rt.attach(CHAT, { attachment: { kind: 'voice', text: String(call.args.text) }, send: async () => { wechat.push(`[语音] ${String(call.args.text)}`); return { ok: true } } })
  }
  const agent = createScriptedAcpAgent({ turns: o.turns, onToolCall })
  const provider = createAcpCursorChatProvider({ bin: 'cursor-agent', model: 'auto', log: () => {}, mcpSpecs: { wechat: null, delegate: null }, spawn: agent.spawn })
  const registry = createProviderRegistry()
  registry.register('cursor', provider, { displayName: 'Cursor', canResume: () => true })
  const data = new Map<string, { mode: Mode }>([[CHAT, { mode: { kind: 'solo', provider: 'cursor' } }]])
  const sessions: Array<{ close(): Promise<void> }> = []
  const permissionMode = o.permissionMode ?? 'dangerously'
  let live: Awaited<ReturnType<typeof provider.spawn>> | undefined
  const c = createConversationCoordinator({
    resolveProject: () => ({ alias: 'a', path: '/p' }),
    manager: {
      // 常驻进程:同一会话里的多轮复用一个 cursor-agent acp(生产的 session manager 也是这样)。
      acquire: vi.fn(async () => {
        if (!live) { live = await provider.spawn({ alias: 'a', path: '/p' }, { tierProfile: TIER_PROFILES.admin, permissionMode, chatId: CHAT }); sessions.push(live) }
        const s = live
        return { alias: 'a', path: '/p', providerId: 'cursor', lastUsedAt: 0, dispatch: (t: string) => s.dispatch(t), cancel: async () => { await s.cancel?.() }, close: async () => {} }
      }),
      release: vi.fn(async () => {}),
    } as unknown as ConversationCoordinatorDeps['manager'],
    conversationStore: { get: (id: string) => data.get(id) ?? null, set: vi.fn(), setParticipants: vi.fn() },
    registry,
    defaultProviderId: 'cursor',
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
  const close = async () => { for (const s of sessions) await s.close() }
  return { send, close, wechat, notices, logs, records, captured, agent }
}

/** 同一个模型行为,两套词汇:legacy 用 reply 工具说话;daemon 把话写在最后。 */
const say = (s: string): ScriptStep => ({ say: s })
const mcp = (tool: string, args: Record<string, unknown> = {}, identity: 'update' | 'none' = 'update', server = 'wechat', ifRejected?: ScriptStep[]): ScriptStep =>
  ({ mcp: { server, tool, args }, identity, ...(ifRejected ? { ifRejected } : {}) })

const ANSWER = '你现在有两个项目:wechat-cc 和 blog。'
const legacyTurn = (identity: 'update' | 'none', server = 'wechat'): ScriptedTurn => ({ steps: [
  { think: '用户问项目' }, say('我先看一下项目列表。'), mcp('list_projects', {}, identity, server),
  mcp('reply', { chat_id: CHAT, text: ANSWER }, identity, server, [say(`reply 工具被拒了,直接说:${ANSWER}`)]),
  say('已回复项目列表。'),
] })
const daemonTurn = (identity: 'update' | 'none', server = 'wechat'): ScriptedTurn => ({ steps: [
  { think: '用户问项目' }, say('我先看一下项目列表。'), mcp('list_projects', {}, identity, server), say(ANSWER),
] })

describe.skipIf(process.platform === 'win32')('Cursor:双发旁白在 daemon 模式下结构性消失(生产的 ACP 客户端 + 真机报文形状)', () => {
  it('legacy(对照):身份照 2026-09-17 真机带在 tool_call_update 里 ⇒ reply 认得出,只有 reply 的那句', async () => {
    const t = rig({ turns: [legacyTurn('update')], mode: 'legacy' })
    await t.send(); await t.close()
    expect(t.wechat).toEqual([ANSWER])
    expect(t.logs.some(l => l.startsWith('[FALLBACK_REPLY]'))).toBe(false)
  })

  it('legacy(复现根因):CLI 不再带身份 / server 名换了 ⇒ 认不出 reply ⇒ FALLBACK_REPLY 把旁白一段一段发出去(双发)', async () => {
    for (const [identity, server] of [['none', 'wechat'], ['update', 'wechat-cc:wechat']] as const) {
      const t = rig({ turns: [legacyTurn(identity, server)], mode: 'legacy' })
      await t.send(); await t.close()
      expect(t.logs.some(l => l.startsWith('[FALLBACK_REPLY]'))).toBe(true)
      // reply 工具已经发了一次正文,FALLBACK 再把「我先看一下」「已回复项目列表。」当回复各发一条。
      expect(t.wechat).toEqual([ANSWER, '我先看一下项目列表。', '已回复项目列表。'])
    }
  })

  it('legacy(复现根因):strict 下 reply 调用被权限卡拒掉 ⇒ 调用照样被认成「回过了」⇒ 这一轮的话全丢,主人什么都没收到', async () => {
    const t = rig({ turns: [legacyTurn('update')], mode: 'legacy', permissionMode: 'strict' })
    await t.send(); await t.close()
    // 模型看到被拒、改用文字说了正文,但协调器只看「调过 reply」⇒ 全丢。
    expect(t.wechat).toEqual([])
    expect(t.logs.some(l => l.startsWith('[FALLBACK_REPLY]'))).toBe(false)
  })

  it('daemon:只交付最后一段,一次;没有 FALLBACK_REPLY;身份带不带 / server 名是什么 / strict 与否,交付一字不差', async () => {
    const outcomes: string[][] = []
    for (const [identity, server, pm] of [['update', 'wechat', 'dangerously'], ['none', 'wechat', 'dangerously'], ['update', 'wechat-cc:wechat', 'dangerously'], ['update', 'wechat', 'strict']] as const) {
      const t = rig({ turns: [daemonTurn(identity, server)], mode: 'daemon', permissionMode: pm })
      await t.send(); await t.close()
      expect(t.logs.some(l => l.startsWith('[FALLBACK_REPLY]'))).toBe(false)
      expect(t.records[0]).toMatchObject({ provider: 'cursor', outcome: 'completed', delivery: 'text', bubbles: 1, narrationSegments: 1, replyToolCalled: false })
      outcomes.push(t.wechat)
    }
    for (const o of outcomes) expect(o).toEqual([ANSWER])
  })

  it('daemon:同一个常驻会话连跑四轮,每轮恰好一条(会话复用不串轮)', async () => {
    const turns = ['在的。', '收到。', '好的,只回一句。', '嗯。'].map(a => ({ steps: [{ think: 'x' }, say(a)] }))
    const t = rig({ turns, mode: 'daemon' })
    for (let i = 0; i < 4; i++) await t.send(`第 ${i + 1} 轮`)
    await t.close()
    expect(t.wechat).toEqual(['在的。', '收到。', '好的,只回一句。', '嗯。'])
    expect(t.agent.children).toHaveLength(1)
    expect(t.records.map(r => r.bubbles)).toEqual([1, 1, 1, 1])
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

  it('daemon:Cursor 额度用完(整轮就是催升级的话)⇒ 当错误收尾,只发通知,原文不交付', async () => {
    const t = rig({ turns: [{ steps: [say('Upgrade your plan to continue.')] }], mode: 'daemon' })
    await t.send(); await t.close()
    expect(t.wechat).toEqual([])
    expect(t.notices).toHaveLength(1)
    expect(t.records[0]).toMatchObject({ outcome: 'error', errorCode: 'quota' })
  })

  // Cursor 把自己的报错写进助理消息、stopReason 仍是 end_turn(#206 发现)。ACP 边界认出最后那一整块 ⇒ 带码错误收尾。
  const LOOPING = 'Error: NonRetriableError: Agent Looping Detected The model got stuck in a repeating response pattern, so this turn was stopped. Please try again with a different model or start a new conversation. If the problem persists, please contact support.'
  it('两臂:Cursor 的带内报错(Agent Looping Detected)不当回复发;回合记 error + provider_error;daemon 只发一条通知', async () => {
    const turn = (): ScriptedTurn => ({ steps: [say('我再 ping 一次。'), mcp('ping'), say('data must NOT have additional properties'), { cliError: LOOPING }] })
    const d = rig({ turns: [turn()], mode: 'daemon' })
    await d.send(); await d.close()
    expect(d.wechat).toEqual([])
    expect(d.notices).toHaveLength(1)
    expect(d.notices[0]).not.toMatch(/Looping|NonRetriable/)
    expect(d.records[0]).toMatchObject({ outcome: 'error', errorCode: 'provider_error' })
    const l = rig({ turns: [turn()], mode: 'legacy' })
    await l.send(); await l.close()
    expect(l.wechat.join('\n')).not.toMatch(/Looping|NonRetriable/)
    expect(l.records[0]).toMatchObject({ outcome: 'error', errorCode: 'provider_error' })
  })

  it('daemon:正文里只是提到 looping / Agent Looping Detected ⇒ 照常交付', async () => {
    const prose = '我检查过了，日志里没有 Agent Looping Detected，也没有 looping。'
    const t = rig({ turns: [{ steps: [say(prose)] }], mode: 'daemon' })
    await t.send(); await t.close()
    expect(t.wechat).toEqual([prose])
    expect(t.notices).toEqual([])
    expect(t.records[0]).toMatchObject({ outcome: 'completed' })
  })

  it('daemon:「Please sign in to continue」⇒ auth_failed:不发原文,走登录提示(带 cursor-agent login)', async () => {
    const t = rig({ turns: [{ steps: [{ cliError: 'Please sign in to continue' }] }], mode: 'daemon' })
    await t.send(); await t.close()
    expect(t.wechat).toEqual([])
    expect(t.notices.join('\n')).toContain('cursor-agent login')
    expect(t.notices.join('\n')).not.toContain('Please sign in')
    expect(t.records[0]).toMatchObject({ outcome: 'auth_failed', errorCode: 'auth_failed' })
  })

  it('daemon:带内的限流 / 断网按码说原因(不读原文)', async () => {
    for (const [body, code] of [['Error: RetriableError: [resource_exhausted] slow down', 'rate_limited'], ['Error: RetriableError: [unavailable] getaddrinfo ENOTFOUND api2.cursor.sh', 'network']] as const) {
      const t = rig({ turns: [{ steps: [{ cliError: body }] }], mode: 'daemon' })
      await t.send(); await t.close()
      expect(t.wechat).toEqual([])
      expect(t.records[0]).toMatchObject({ outcome: 'error', errorCode: code })
      expect(t.notices[0]).not.toContain('RetriableError')
    }
  })
})

// ─── 原样回放 2026-09-17 真机录到的 cursor-agent 报文 ──────────────────────────────
type Obj = Record<string, any>
const FIXTURE = fileURLToPath(new URL('./acp/fixtures/cursor-acp-2026-09-17.jsonl', import.meta.url))
const rows = readFileSync(FIXTURE, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as Obj)
/** 一个录到的场景(第一次 session/prompt 之后、它的应答之前)的 update,原样当剧本。 */
function recordedTurn(scenario: string): ScriptedTurn {
  const of = rows.filter(r => r.scenario === scenario)
  const promptAt = of.findIndex(r => r.dir === 'out' && r.payload.method === 'session/prompt')
  const promptId = of[promptAt]!.payload.id
  const steps: ScriptStep[] = []
  let stopReason = 'end_turn'
  for (const r of of.slice(promptAt + 1)) {
    if (r.dir !== 'in') continue
    if (r.payload.method === 'session/update') steps.push({ raw: r.payload.params.update })
    if (r.payload.method === undefined && r.payload.id === promptId) { stopReason = r.payload.result?.stopReason ?? stopReason; break }
  }
  return { steps, stopReason }
}

describe.skipIf(process.platform === 'win32')('Cursor:回放真机报文(2026-09-17,没有 reply 工具的那几轮)', () => {
  it('c1「新建 hello.txt」:legacy FALLBACK 发两条(「正在创建」旁白 + 结果);daemon 只发结果', async () => {
    const l = rig({ turns: [recordedTurn('c1')], mode: 'legacy' })
    await l.send(); await l.close()
    expect(l.wechat).toEqual(['正在创建 `hello.txt`。', '已创建 `hello.txt`，内容为一行 `hello`。'])
    const d = rig({ turns: [recordedTurn('c1')], mode: 'daemon' })
    await d.send(); await d.close()
    expect(d.wechat).toEqual(['已创建 `hello.txt`，内容为一行 `hello`。'])
    expect(d.records[0]).toMatchObject({ narrationSegments: 1, bubbles: 1 })
  })

  it('c4both(真机:最后一块是 Cursor 自己写的「Agent Looping Detected」,stopReason end_turn)⇒ 两臂都不把这句当回复', async () => {
    const d = rig({ turns: [recordedTurn('c4both')], mode: 'daemon' })
    await d.send(); await d.close()
    expect(d.wechat).toEqual([])
    expect(d.notices).toHaveLength(1)
    expect(d.records[0]).toMatchObject({ outcome: 'error', errorCode: 'provider_error' })
    expect(d.records[0]!.error).toMatch(/^Error: NonRetriableError: Agent Looping Detected/)
    const l = rig({ turns: [recordedTurn('c4both')], mode: 'legacy' })
    await l.send(); await l.close()
    expect(l.wechat.join('\n')).not.toContain('Agent Looping Detected')
    expect(l.records[0]).toMatchObject({ outcome: 'error', errorCode: 'provider_error' })
  })

  it('c2(命令被拒,一段两句):两臂一样 —— 只有一段文字,daemon 按空行分两条;legacy FALLBACK 一条', async () => {
    const l = rig({ turns: [recordedTurn('c2shellreject')], mode: 'legacy' })
    await l.send(); await l.close()
    const d = rig({ turns: [recordedTurn('c2shellreject')], mode: 'daemon' })
    await d.send(); await d.close()
    expect(l.wechat).toHaveLength(1)
    expect(d.wechat.join('\n\n')).toBe(l.wechat[0])
  })
})
