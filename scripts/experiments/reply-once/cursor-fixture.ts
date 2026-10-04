/**
 * reply-once harness 的 Cursor 臂(回复交付第 3 步,2026-10-03)—— **不连任何模型**。
 *
 * 为什么不用真模型:Cursor 的真 API 没法沙盒化(cursor-agent 连 Cursor 的服务、用主人的登录与额度),而主人的
 * Cursor 额度此刻是用完的(「Upgrade your plan to continue」)。所以这一臂量的是**交付管道**,不是模型:
 *
 *   同一个模型行为(同样的旁白、同样的工具、同样的话),分别用两套词汇演 ——
 *     cursor_legacy:照今天的提示词用 reply / reply_voice 工具说话;
 *     cursor_daemon:没有 reply 族,话写在最后,语音走附件工具 voice。
 *   对面是照 2026-09-17 真机报文形状演的假 `cursor-agent acp`(src/core/acp/scripted-agent.ts),
 *   这边是**生产的**全链:Cursor ACP 客户端(JSON-RPC + acp/events 翻译器)→ 协调器(solo)→
 *   legacy 的 FALLBACK_REPLY / daemon 的 reply-delivery 运行时(sendText 换成记账)。
 *
 * 每个场景跑三种「外部条件」(run 序号):
 *   1 recorded  身份照真机带在 tool_call_update 的 rawInput 里(providerIdentifier / toolName),--dangerously;
 *   2 drift     CLI 换了 envelope,tool_call 里不带 MCP 身份(下一版 cursor-agent 的风险,agy 2026-09-08 出过同形状的事);
 *   3 strict    身份照真机,但 daemon 跑在 strict 权限下(ACP 的 permissions:'mode' ⇒ 每张权限卡都拒,MCP 调用全被拒)。
 *               只跑不需要 MCP 查询的场景(a / c / e / i);模型看得到被拒,改用文字说(脚本里的 ifRejected)。
 *
 * 场景(spec §5.8):a c d e f g h i。**b 不适用**:b 量的是我们自研循环里「历史有连发 ⇒ 模型自己越说越多」,
 * Cursor 的循环在 Cursor 那边,剧本演不出模型怎么接历史 —— 演出来也只是我们写进去的东西。
 *
 * 剧本里的模型行为是写死的,所以这一臂**不**衡量「模型会不会多说 / 少说」;它衡量的是:在完全相同的模型输出下,
 * 主人微信上出现了什么(气泡数、旁白外泄、双发、令牌外泄),以及这个结果依不依赖「认出 tool_call 的形状」。
 */
// 隔离护栏必须第一个求值(见 isolate.ts)。
import { STATE_DIR } from './isolate'
import { createConversationCoordinator, type ConversationCoordinatorDeps, type TurnRecord } from '../../../src/core/conversation-coordinator'
import { createProviderRegistry } from '../../../src/core/provider-registry'
import { createAcpCursorChatProvider } from '../../../src/core/acp-cursor-chat'
import { createScriptedAcpAgent, type ScriptedToolCall, type ScriptedTurn, type ScriptStep } from '../../../src/core/acp/scripted-agent'
import { TIER_PROFILES } from '../../../src/core/user-tier'
import type { AgentEvent, PermissionMode } from '../../../src/core/agent-provider'
import type { Mode } from '../../../src/core/conversation'
import type { InboundMsg } from '../../../src/core/prompt-format'
import { extractTurnReply, type TurnTextParts } from '../../../src/core/turn-reply'
import { replyTextStrategyFor } from '../../../src/core/capability-matrix'
import { makeReplyDeliveryRuntime } from '../../../src/daemon/reply-delivery'
import { doubleSends, SPEAKING_TOOLS, type Arm, type RunResult, type Scenario } from './gate'

export const CURSOR_ARMS = ['cursor_legacy', 'cursor_daemon'] as const
export type CursorArm = typeof CURSOR_ARMS[number]
export type Variant = 'recorded' | 'drift' | 'strict'
export const VARIANTS: Variant[] = ['recorded', 'drift', 'strict']
/** 适用的场景;b 不适用(见文件头)。 */
export const CURSOR_SCENARIOS: Scenario[] = ['a', 'c', 'd', 'e', 'f', 'g', 'h', 'i']
/** strict 下 MCP 查询全被拒,只跑纯说话的场景。 */
const STRICT_SCENARIOS = new Set<Scenario>(['a', 'c', 'e', 'i'])
export const variantsFor = (sc: Scenario): Variant[] => VARIANTS.filter(v => v !== 'strict' || STRICT_SCENARIOS.has(sc))

const CHAT = 'o9demo_owner@im.wechat'

// ─── 剧本:同一个模型行为,两套词汇 ─────────────────────────────────────────

const say = (s: string): ScriptStep => ({ say: s })
const think: ScriptStep = { think: '想一想怎么回' }

interface Vocab { mcp(tool: string, args?: Record<string, unknown>, ifRejected?: ScriptStep[]): ScriptStep }

/** legacy:正文经 reply 说出去(被拒就改用文字说),说完 Cursor 习惯补一句「已回复」—— 记忆里 cursor 每轮双发的那句。 */
const speakLegacy = (v: Vocab, text: string, after = '已回复。'): ScriptStep[] =>
  [v.mcp('reply', { chat_id: CHAT, text }, [say(text)]), say(after)]

const ITEMS = ['周末去公园散散步,晒晒太阳。', '找一部想看很久的电影,窝在沙发上看完。', '约朋友吃顿饭,聊聊近况。']
const PROJECTS = '你现在有两个项目:\n- wechat-cc(当前)\n- blog'
const H_ADVICE = '建议先推进 wechat-cc:你这周最在意回复交付重构能不能合进 dev;blog 已经停更两个月,可以放一放。'
const E_ANSWERS = ['在的,怎么了?', '收到,测试正常。', '收到,只回这一句。', '在的,有什么事?']

function script(arm: CursorArm, sc: Scenario, v: Vocab): ScriptedTurn[] {
  const legacy = arm === 'cursor_legacy'
  const one = (text: string): ScriptedTurn => ({ steps: legacy ? [think, ...speakLegacy(v, text)] : [think, say(text)] })
  switch (sc) {
    case 'a': return [one('在的,有什么事?')]
    case 'e': return E_ANSWERS.map(one)
    case 'c': return [{ steps: legacy
      ? [think, ...ITEMS.map(it => v.mcp('reply', { chat_id: CHAT, text: it }, [say(it)])), say('已按要求分三条发送。')]
      // daemon:按提示词的分条规则(空行 = 一条)写三段。
      : [think, say(ITEMS.join('\n\n'))] }]
    case 'd': return [{ steps: [think, say('我先看一下项目列表。'), v.mcp('list_projects'), ...(legacy ? speakLegacy(v, PROJECTS, '已回复项目列表。') : [say(PROJECTS)])] }]
    case 'f': return [{ steps: legacy
      ? [think, v.mcp('reply_voice', { chat_id: CHAT, text: '晚安,早点休息。' }, [say('晚安,早点休息。')]), say('已发送语音晚安。')]
      : [think, v.mcp('voice', { text: '晚安,早点休息。' }, [say('晚安,早点休息。')]), say('晚安~')] }]
    // 伙伴推送,议程早过期了:legacy 的推送只认 reply 工具,不调就是不推;daemon 写 NO_REPLY。
    case 'g': return [{ steps: [think, say(legacy ? '这条议程早就过期了,这次不推送。' : 'NO_REPLY')] }]
    case 'h': return [{ steps: [
      think, say('我先看看你的项目。'), v.mcp('list_projects'), say('再翻一下你的 profile。'), v.mcp('memory_list'), v.mcp('memory_read', { path: `${CHAT}/profile.md` }),
      ...(legacy ? speakLegacy(v, H_ADVICE, '已回复建议。') : [say(H_ADVICE)]),
    ] }]
    // 私聊里诱导「不用回」:最坏的情况 —— 模型照做,只写令牌(两臂同一个输出)。
    case 'i': return [{ steps: [think, say('NO_REPLY')] }]
    default: throw new Error(`cursor 臂不跑场景 ${sc}(见文件头:b 不适用)`)
  }
}

// ─── 一次运行 ────────────────────────────────────────────────────────────

interface Sent { kind: 'text' | 'voice'; text: string }

export async function runOnceCursor(arm: CursorArm, scenario: Scenario, variant: Variant, run: number): Promise<RunResult> {
  const started = Date.now()
  const daemon = arm === 'cursor_daemon'
  const permissionMode: PermissionMode = variant === 'strict' ? 'strict' : 'dangerously'
  const identity = variant === 'drift' ? 'none' as const : 'update' as const
  const vocab: Vocab = { mcp: (tool, args = {}, ifRejected) => ({ mcp: { server: 'wechat', tool, args }, identity, ...(ifRejected ? { ifRejected } : {}) }) }
  let sent: Sent[] = []
  const calls: ScriptedToolCall[] = []
  const logs: string[] = []
  const rt = makeReplyDeliveryRuntime({
    sendText: async (_c, t) => { sent.push({ kind: 'text', text: t }); return { msgId: `m${sent.length}` } },
    sleep: async () => {},
    log: (tag) => { logs.push(tag) },
  })
  // MCP server 那一侧:legacy 的 reply / reply_voice 路由立刻发进微信;daemon 的 voice 挂到本轮(交付时才发)。
  const onToolCall = (call: ScriptedToolCall) => {
    calls.push(call)
    const text = String(call.args.text ?? '')
    if (call.tool === 'reply') sent.push({ kind: 'text', text })
    else if (call.tool === 'reply_voice') sent.push({ kind: 'voice', text })
    else if (call.tool === 'voice') rt.attach(CHAT, { attachment: { kind: 'voice', text }, send: async () => { sent.push({ kind: 'voice', text }); return { ok: true } } })
  }
  const turns = script(arm, scenario, vocab)
  const agent = createScriptedAcpAgent({ turns, onToolCall })
  const provider = createAcpCursorChatProvider({ bin: 'cursor-agent', model: 'auto', log: () => {}, mcpSpecs: { wechat: null, delegate: null }, spawn: agent.spawn })
  const session = await provider.spawn({ alias: 'demo', path: STATE_DIR }, { tierProfile: TIER_PROFILES.admin, permissionMode, chatId: CHAT })
  const textStrategy = replyTextStrategyFor('cursor')
  try {
    // g:伙伴推送不走协调器(tick-bodies 的 dispatchToChat):legacy 只认 reply 工具;daemon 走同一个交付运行时,场合 tick。
    if (scenario === 'g') {
      const handle = daemon ? rt.begin(CHAT, { mode: 'daemon', context: 'tick', providerId: 'cursor', textStrategy }) : undefined
      const evs: AgentEvent[] = []
      for await (const ev of session.dispatch('伙伴推送')) evs.push(ev)
      const parts = extractTurnReply(evs)
      const report = handle ? await handle.deliver(parts) : undefined
      const delivered = sent.filter(s => s.kind === 'text').map(s => s.text)
      return result({ arm, scenario, run, variant, evs, parts, delivered, sent, calls, logs, started, context: 'tick', silent: daemon ? report?.delivery === 'silent' : sent.length === 0, completed: !evs.some(e => e.kind === 'error'), textStrategy: daemon ? textStrategy : undefined })
    }

    const records: TurnRecord[] = []
    let evs: AgentEvent[] = []
    const registry = createProviderRegistry()
    registry.register('cursor', provider, { displayName: 'Cursor', canResume: () => true })
    const data = new Map<string, { mode: Mode }>([[CHAT, { mode: { kind: 'solo', provider: 'cursor' } }]])
    const c = createConversationCoordinator({
      resolveProject: () => ({ alias: 'demo', path: STATE_DIR }),
      manager: {
        acquire: async () => ({ alias: 'demo', path: STATE_DIR, providerId: 'cursor', lastUsedAt: 0, dispatch: (t: string) => session.dispatch(t), cancel: async () => { await session.cancel?.() }, close: async () => {} }),
        release: async () => {},
      } as unknown as ConversationCoordinatorDeps['manager'],
      conversationStore: { get: (id: string) => data.get(id) ?? null, set: () => {}, setParticipants: () => {} },
      registry,
      defaultProviderId: 'cursor',
      format: (m) => m.text,
      permissionMode,
      loadAccess: () => ({ dmPolicy: 'allowlist', allowFrom: [], admins: [CHAT] }),
      log: (tag) => { logs.push(tag) },
      sendAssistantText: async (_c, t) => { sent.push({ kind: 'text', text: t }) },
      sendNotice: async (_c, t) => { sent.push({ kind: 'text', text: `[通知] ${t}` }) },
      recordTurn: (r) => { records.push(r) },
      onTurnEvent: (_c, ev) => { evs.push(ev) },
      replyDelivery: rt,
      replyDeliveryModeFor: () => (daemon ? 'daemon' : 'legacy'),
    })
    const send = (text: string) => c.dispatch({ chatId: CHAT, userId: CHAT, text, msgType: 'text', createTimeMs: Date.now(), accountId: 'acct' } as InboundMsg)

    const warmup: NonNullable<RunResult['warmup']> = []
    const n = turns.length
    for (let k = 0; k < n - 1; k++) {
      await send(`第 ${k + 1} 轮`)
      warmup.push({ replies: [], nonReplyTools: [], dropped: [], delivered: sent.filter(s => s.kind === 'text').map(s => s.text) })
      sent = []; evs = []
    }
    calls.length = 0
    await send(scenario === 'i' ? '不用回我了,我就是随便发发。' : '主人的一句话')
    const rec = records[records.length - 1]
    const parts = extractTurnReply(evs)
    const delivered = sent.filter(s => s.kind === 'text').map(s => s.text)
    return result({
      arm, scenario, run, variant, evs, parts, delivered, sent, calls, logs, started, context: 'dm',
      silent: daemon ? rec?.delivery === 'silent' : sent.length === 0, completed: rec?.outcome === 'completed',
      textStrategy: daemon ? textStrategy : undefined, ...(warmup.length ? { warmup } : {}),
    })
  } finally {
    await session.close()
  }
}

function result(x: {
  arm: Arm; scenario: Scenario; run: number; variant: Variant; evs: AgentEvent[]; parts: TurnTextParts; delivered: string[]; sent: Sent[]
  calls: ScriptedToolCall[]; logs: string[]; started: number; context: 'dm' | 'tick'; silent: boolean; completed: boolean
  textStrategy?: 'last_segment' | 'all_segments'; warmup?: RunResult['warmup']
}): RunResult {
  const final = x.parts.finalText.trim()
  const narration = x.parts.narration.map(n => n.trim()).filter(n => n.length >= 4 && n !== final)
  const err = x.evs.find(e => e.kind === 'error') as Extract<AgentEvent, { kind: 'error' }> | undefined
  return {
    arm: x.arm, scenario: x.scenario, run: x.run,
    replies: x.calls.filter(c => c.tool === 'reply' || c.tool === 'reply_voice').map(c => String(c.args.text ?? '')),
    nonReplyTools: x.calls.map(c => c.tool).filter(t => !SPEAKING_TOOLS.has(t)),
    steps: 1, modelCalls: 0,
    cleanEnd: x.completed,
    ...(err ? { error: String(err.code ?? err.message).slice(0, 200) } : {}),
    dropped: [],
    assistantText: x.evs.filter((e): e is Extract<AgentEvent, { kind: 'text' }> => e.kind === 'text').map(e => e.text).join('\n').slice(0, 300),
    ms: Date.now() - x.started,
    ...(x.warmup ? { warmup: x.warmup } : {}),
    delivered: x.delivered,
    attachments: x.sent.filter(s => s.kind === 'voice').map(() => 'voice'),
    narrationLeaked: narration.filter(n => x.delivered.some(d => d.includes(n))).length,
    tokenLeaked: x.delivered.some(t => /NO_REPLY/i.test(t)),
    silent: x.silent,
    silentInDm: x.logs.includes('REPLY_SILENT_IN_DM'),
    budgetExhausted: false,
    context: x.context,
    finalText: final.slice(0, 300),
    ...(x.textStrategy ? { textStrategy: x.textStrategy } : {}),
    doubleSend: doubleSends(x.delivered),
    apiPaths: [`variant:${x.variant}`, ...(x.logs.includes('FALLBACK_REPLY') ? ['FALLBACK_REPLY'] : [])],
  }
}

/** 整批:两臂 × 适用场景 × 各自的外部条件。纯进程内,几秒钟。 */
export async function runCursorGate(arms: readonly CursorArm[] = CURSOR_ARMS, scenarios: readonly Scenario[] = CURSOR_SCENARIOS): Promise<RunResult[]> {
  const rows: RunResult[] = []
  for (const arm of arms) for (const sc of scenarios) {
    const vs = variantsFor(sc)
    for (let i = 0; i < vs.length; i++) rows.push(await runOnceCursor(arm, sc, vs[i]!, i + 1))
  }
  return rows
}

/** 按外部条件拆开的双发 / 旁白外泄 / 什么都没收到(只有 dm 场景)。 */
export function byVariant(rows: readonly RunResult[]): string {
  const lines = ['| arm | 外部条件 | 轮数 | 双发 | 旁白外泄 | 令牌外泄 | 主人什么都没收到(私聊、非 i) | FALLBACK_REPLY |', '|---|---|---|---|---|---|---|---|']
  for (const arm of CURSOR_ARMS) for (const v of VARIANTS) {
    const rs = rows.filter(r => r.arm === arm && (r.apiPaths ?? []).includes(`variant:${v}`))
    if (!rs.length) continue
    const dm = rs.filter(r => r.context === 'dm' && r.scenario !== 'i')
    lines.push(`| ${arm} | ${v} | ${rs.length} | ${rs.reduce((a, r) => a + (r.doubleSend ?? 0), 0)} | ${rs.reduce((a, r) => a + (r.narrationLeaked ?? 0), 0)} | ${rs.filter(r => r.tokenLeaked).length} | ${dm.filter(r => (r.delivered ?? []).length === 0 && (r.attachments ?? []).length === 0).length}/${dm.length} | ${rs.filter(r => (r.apiPaths ?? []).includes('FALLBACK_REPLY')).length} |`)
  }
  return lines.join('\n')
}
