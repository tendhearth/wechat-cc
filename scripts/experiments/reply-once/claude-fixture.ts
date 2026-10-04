/**
 * reply-once harness 的 Claude 剧本臂(回复交付第 5 步,2026-10-03)—— **不连任何模型**。
 *
 * Claude 的真模型连 api.anthropic.com、用主人的订阅登录,只能小批跑(见 claude-sandbox.ts 与 harness 的 claude_real_*
 * 臂)。这一臂量的是**交付管道**,不是模型:
 *
 *   同一个模型行为(同样的旁白、同样的工具、同样的话),分别用两套词汇演 ——
 *     claude_legacy:照今天的提示词用 reply / reply_voice 工具说话,reply 之后不再写字;
 *     claude_daemon:没有 reply 族,话写在最后一段,语音走附件工具 voice。
 *   对面是照 Agent SDK 消息形状演的假 `query()`(src/core/claude-scripted.ts),这边是**生产的**全链:
 *   Claude provider(createClaudeAgentProvider 的消息翻译)→ 协调器(solo)→ legacy 的 FALLBACK_REPLY /
 *   daemon 的 reply-delivery 运行时(sendText 换成记账)。
 *
 * 每个场景跑这几种「外部条件」(run 序号):
 *   1 recorded    每个内容块单独一条 assistant 消息(Claude Code 流式输出的样子,真跑核对过);
 *   2 bundled     一次响应的所有块在同一条 assistant 消息里(SDK 类型允许、回放 / 旧版本)—— provider 以前在这里
 *                 先发 tool_call 再发文字,开场被算进工具之后的段;
 *   3 drift       wechat MCP 挂在 Claude Code 插件 MCP 的名字下(`mcp__plugin_<插件>_<server>__reply`)⇒ 认不出 reply;
 *   4 tool_error  wechat 的工具调用失败(MCP 起不来 / 内部 API 拒了)⇒ 模型看得到失败,改用文字说(ifError)。
 *                 只跑不需要 MCP 查询的场景(a / c / e / i)。
 *
 * 场景(spec §5.8):a c d e f g h i,外加 b(Claude 版):**会话续接**跨过开关 —— 历史里是 reply 工具说话,翻到
 * daemon 之后 reply 已不在工具表里,模型第一轮照旧去调(「No such tool available」),然后把话写在最后(spec §7 风险)。
 */
// 隔离护栏必须第一个求值(见 isolate.ts)。
import { STATE_DIR } from './isolate'
import { createConversationCoordinator, type ConversationCoordinatorDeps, type TurnRecord } from '../../../src/core/conversation-coordinator'
import { createProviderRegistry } from '../../../src/core/provider-registry'
import { createClaudeAgentProvider } from '../../../src/core/claude-agent-provider'
import { createScriptedClaude, type ClaudeScriptedCall, type ClaudeScriptedTurn, type ClaudeScriptStep, type ClaudeShape } from '../../../src/core/claude-scripted'
import { TIER_PROFILES } from '../../../src/core/user-tier'
import type { AgentEvent } from '../../../src/core/agent-provider'
import type { Mode } from '../../../src/core/conversation'
import type { InboundMsg } from '../../../src/core/prompt-format'
import { extractTurnReply, type TurnTextParts } from '../../../src/core/turn-reply'
import { replyTextStrategyFor } from '../../../src/core/capability-matrix'
import { makeReplyDeliveryRuntime } from '../../../src/daemon/reply-delivery'
import { doubleSends, META_RE, SPEAKING_TOOLS, type Arm, type RunResult, type Scenario } from './gate'

export const CLAUDE_ARMS = ['claude_legacy', 'claude_daemon'] as const
export type ClaudeArm = typeof CLAUDE_ARMS[number]
export const VARIANTS: ClaudeShape[] = ['recorded', 'bundled', 'drift', 'tool_error']
export const CLAUDE_SCENARIOS: Scenario[] = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']
/** tool_error 下 wechat 工具全失败,只跑纯说话的场景。 */
const TOOL_ERROR_SCENARIOS = new Set<Scenario>(['a', 'c', 'e', 'i'])
export const variantsFor = (sc: Scenario): ClaudeShape[] => VARIANTS.filter(v => v !== 'tool_error' || TOOL_ERROR_SCENARIOS.has(sc))

const CHAT = 'o9demo_owner@im.wechat'

// ─── 剧本:同一个模型行为,两套词汇 ─────────────────────────────────────────

const say = (s: string): ClaudeScriptStep => ({ say: s })
const think: ClaudeScriptStep = { think: '想一想怎么回' }
const wx = (tool: string, args: Record<string, unknown> = {}, ifError?: ClaudeScriptStep[]): ClaudeScriptStep =>
  ({ tool, server: 'wechat', args, ...(ifError ? { ifError } : {}) })

/** 剧本里所有「工具前的开场」—— 进了微信就是旁白外泄。 */
const NARRATION = ['我查一下当前登记的项目。', '我先看看项目列表和记忆里的近况。', '顺便看下仓库状态。', '我先确认一下语音配置。']
/**
 * legacy:正文经 reply 发出;失败(tool_error)⇒ 模型看到失败,改用文字说。reply 之后真 Claude **每轮**再写一句自述
 * (2026-10-03 真跑 6/6:「已回复,测试通过。」「晚安语音发出去了 🌙」「嗯，回了一句轻的就好。」,见
 * src/core/fixtures/claude-sdk-2026-10-03.jsonl)—— 认得出 reply 时被丢掉,认不出就是第二条。
 */
const SELF_NARRATION = '已回复。'
const speakLegacy = (text: string): ClaudeScriptStep[] => [wx('reply', { chat_id: CHAT, text }, [say(text)]), say(SELF_NARRATION)]

const ITEMS = ['周末去公园散散步,晒晒太阳。', '找一部想看很久的电影,窝在沙发上看完。', '约朋友吃顿饭,聊聊近况。']
const PROJECTS = '目前登记了 2 个项目:\n• wechat-cc(当前项目)\n• blog'
const H_ADVICE = '建议先推进 wechat-cc:你这周最在意回复交付重构能不能合进 dev,仓库里也还有没提交的改动;blog 已经停更两个月,可以放一放。'
const E_ANSWERS = ['在的,怎么了?', '收到,测试正常。', '收到,只回这一句。', '在的,有什么事?']
const GOODNIGHT = '晚安,今天辛苦啦。早点休息,做个好梦。'
const B_ANSWER = '好,这次就一句:收到了。'

function script(arm: ClaudeArm, sc: Scenario): ClaudeScriptedTurn[] {
  const legacy = arm === 'claude_legacy'
  const one = (text: string): ClaudeScriptedTurn => ({ steps: legacy ? [think, ...speakLegacy(text)] : [think, say(text)] })
  switch (sc) {
    case 'a': return [one('在的,有什么事?')]
    case 'e': return E_ANSWERS.map(one)
    // b(Claude 版):会话里前一轮是 legacy 的 reply 连发;翻开关后同一个会话续上。daemon 的第一轮模型照旧去调 reply ——
    // 工具已不在表里(Claude Code 回「No such tool available」,剧本里按工具失败演),它再把话写在最后。
    case 'b': return [
      { steps: [think, wx('reply', { chat_id: CHAT, text: '第一条。' }), wx('reply', { chat_id: CHAT, text: '第二条。' })] },
      { steps: legacy ? [think, ...speakLegacy(B_ANSWER)] : [think, { tool: 'reply', server: 'wechat', args: { chat_id: CHAT, text: B_ANSWER }, fail: true }, say(B_ANSWER)] },
    ]
    case 'c': return [{ steps: legacy
      ? [think, ...ITEMS.map(it => wx('reply', { chat_id: CHAT, text: it }, [say(it)])), say(SELF_NARRATION)]
      : [think, say(ITEMS.join('\n\n'))] }]
    case 'd': return [{ steps: [think, say('我查一下当前登记的项目。'), wx('list_projects'), ...(legacy ? speakLegacy(PROJECTS) : [say(PROJECTS)])] }]
    case 'f': return [{ steps: [think, say('我先确认一下语音配置。'), wx('voice_config_status'), ...(legacy
      ? [wx('reply_voice', { chat_id: CHAT, text: GOODNIGHT }, [say(GOODNIGHT)]), say('晚安语音发出去了 🌙')]
      : [wx('voice', { text: GOODNIGHT }, [say(GOODNIGHT)]), say(GOODNIGHT)])] }]
    // 伙伴推送,议程早过期了:legacy 的推送只认 reply 工具,不调就是不推(Claude 照例写一句自述);daemon 写 NO_REPLY。
    case 'g': return [{ steps: [think, wx('memory_list'), wx('memory_read', { path: `${CHAT}/profile.md` }), say(legacy ? '议程已过期,这次不推送。' : 'NO_REPLY')] }]
    case 'h': return [{ steps: [
      think, say('我先看看项目列表和记忆里的近况。'), wx('list_projects'), wx('memory_list'), wx('memory_read', { path: `${CHAT}/profile.md` }),
      say('顺便看下仓库状态。'), { tool: 'Bash', args: { command: 'git status --short' } },
      ...(legacy ? speakLegacy(H_ADVICE) : [say(H_ADVICE)]),
    ] }]
    // 私聊里诱导「不用回」:最坏的情况 —— 模型照做,只写令牌(两臂同一个输出)。
    case 'i': return [{ steps: [think, say('NO_REPLY')] }]
    default: throw new Error(`claude 剧本臂不跑场景 ${sc}`)
  }
}

// ─── 一次运行 ────────────────────────────────────────────────────────────

interface Sent { kind: 'text' | 'voice'; text: string }

export async function runOnceClaudeFixture(arm: ClaudeArm, scenario: Scenario, variant: ClaudeShape, run: number): Promise<RunResult> {
  const started = Date.now()
  const daemon = arm === 'claude_daemon'
  let sent: Sent[] = []
  const calls: ClaudeScriptedCall[] = []
  const logs: string[] = []
  const rt = makeReplyDeliveryRuntime({
    sendText: async (_c, t) => { sent.push({ kind: 'text', text: t }); return { msgId: `m${sent.length}` } },
    sleep: async () => {},
    log: (tag) => { logs.push(tag) },
  })
  // MCP server 那一侧:legacy 的 reply / reply_voice 路由立刻发进微信;daemon 的 voice 挂到本轮(交付时才发)。
  // b 的 daemon 轮里那次 reply 调用失败(工具不在表里)⇒ 剧本不回调,什么都不发。
  const onToolCall = (call: ClaudeScriptedCall) => {
    calls.push(call)
    const text = String(call.args.text ?? '')
    if (call.server !== 'wechat') return
    if (call.tool === 'reply') sent.push({ kind: 'text', text })
    else if (call.tool === 'reply_voice') sent.push({ kind: 'voice', text })
    else if (call.tool === 'voice') rt.attach(CHAT, { attachment: { kind: 'voice', text }, send: async () => { sent.push({ kind: 'voice', text }); return { ok: true } } })
  }
  const turns = script(arm, scenario)
  const scripted = createScriptedClaude({ turns, onToolCall, shape: variant })
  const provider = createClaudeAgentProvider({ sdkOptionsForProject: () => ({}), queryImpl: scripted.query })
  const session = await provider.spawn({ alias: 'demo', path: STATE_DIR }, { tierProfile: TIER_PROFILES.admin, permissionMode: 'dangerously', chatId: CHAT })
  const textStrategy = replyTextStrategyFor('claude')
  try {
    if (scenario === 'g') {
      const handle = daemon ? rt.begin(CHAT, { mode: 'daemon', context: 'tick', providerId: 'claude', textStrategy }) : undefined
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
    registry.register('claude', provider, { displayName: 'Claude', canResume: () => true })
    const data = new Map<string, { mode: Mode }>([[CHAT, { mode: { kind: 'solo', provider: 'claude' } }]])
    // b:第一轮(续接前的历史)永远是 legacy;第二轮才是这一臂。
    let turnNo = 0
    const c = createConversationCoordinator({
      resolveProject: () => ({ alias: 'demo', path: STATE_DIR }),
      manager: {
        acquire: async () => ({ alias: 'demo', path: STATE_DIR, providerId: 'claude', lastUsedAt: 0, dispatch: (t: string) => session.dispatch(t), cancel: async () => { await session.cancel?.() }, close: async () => {} }),
        release: async () => {},
      } as unknown as ConversationCoordinatorDeps['manager'],
      conversationStore: { get: (id: string) => data.get(id) ?? null, set: () => {}, setParticipants: () => {} },
      registry,
      defaultProviderId: 'claude',
      format: (m) => m.text,
      permissionMode: 'dangerously',
      loadAccess: () => ({ dmPolicy: 'allowlist', allowFrom: [], admins: [CHAT] }),
      log: (tag) => { logs.push(tag) },
      sendAssistantText: async (_c, t) => { sent.push({ kind: 'text', text: t }) },
      sendNotice: async (_c, t) => { sent.push({ kind: 'text', text: `[通知] ${t}` }) },
      recordTurn: (r) => { records.push(r) },
      onTurnEvent: (_c, ev) => { evs.push(ev) },
      replyDelivery: rt,
      replyDeliveryModeFor: () => (daemon && !(scenario === 'b' && turnNo === 1) ? 'daemon' : 'legacy'),
    })
    const send = (text: string) => { turnNo++; return c.dispatch({ chatId: CHAT, userId: CHAT, text, msgType: 'text', createTimeMs: Date.now(), accountId: 'acct' } as InboundMsg) }

    const warmup: NonNullable<RunResult['warmup']> = []
    const n = turns.length
    for (let k = 0; k < n - 1; k++) {
      await send(`第 ${k + 1} 轮`)
      // b 的第一轮是续接前的历史,不算这一臂的轮次。
      if (scenario !== 'b') warmup.push({ replies: [], nonReplyTools: [], dropped: [], delivered: sent.filter(s => s.kind === 'text').map(s => s.text) })
      sent = []; evs = []
    }
    calls.length = 0
    await send(scenario === 'i' ? '不用回我了,我就是随便发发。' : scenario === 'b' ? '你刚才发了好几条,这次只回一句。' : '主人的一句话')
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
  arm: Arm; scenario: Scenario; run: number; variant: ClaudeShape; evs: AgentEvent[]; parts: TurnTextParts; delivered: string[]; sent: Sent[]
  calls: ClaudeScriptedCall[]; logs: string[]; started: number; context: 'dm' | 'tick'; silent: boolean; completed: boolean
  textStrategy?: 'last_segment' | 'all_segments'; warmup?: RunResult['warmup']
}): RunResult {
  const final = x.parts.finalText.trim()
  const narration = [...new Set([...NARRATION, ...x.parts.narration.map(n => n.trim()).filter(n => n.length >= 4 && n !== final)])]
  const err = x.evs.find(e => e.kind === 'error') as Extract<AgentEvent, { kind: 'error' }> | undefined
  return {
    arm: x.arm, scenario: x.scenario, run: x.run,
    replies: x.calls.filter(c => c.server === 'wechat' && (c.tool === 'reply' || c.tool === 'reply_voice')).map(c => String(c.args.text ?? '')),
    // 非回复工具:真被调用的 wechat MCP 工具 + 内置工具(Bash 这类,从事件里数)。
    nonReplyTools: [
      ...x.calls.filter(c => c.server === 'wechat').map(c => c.tool).filter(t => !SPEAKING_TOOLS.has(t)),
      ...x.calls.filter(c => c.server === undefined).map(c => c.tool),
    ],
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

/** 整批:两臂 × 适用场景 × 各自的外部条件。纯进程内,一两秒。 */
export async function runClaudeFixtureGate(arms: readonly ClaudeArm[] = CLAUDE_ARMS, scenarios: readonly Scenario[] = CLAUDE_SCENARIOS): Promise<RunResult[]> {
  const rows: RunResult[] = []
  for (const arm of arms) for (const sc of scenarios) {
    const vs = variantsFor(sc)
    for (let i = 0; i < vs.length; i++) rows.push(await runOnceClaudeFixture(arm, sc, vs[i]!, i + 1))
  }
  return rows
}

/** 按外部条件拆开的双发 / 旁白外泄 / 什么都没收到(只有 dm 场景)。 */
export function byVariant(rows: readonly RunResult[]): string {
  const lines = ['| arm | 外部条件 | 轮数 | 双发 | 旁白外泄 | 令牌外泄 | 元话语 | 主人什么都没收到(私聊、非 i) | FALLBACK_REPLY |', '|---|---|---|---|---|---|---|---|---|']
  for (const arm of CLAUDE_ARMS) for (const v of VARIANTS) {
    const rs = rows.filter(r => r.arm === arm && (r.apiPaths ?? []).includes(`variant:${v}`))
    if (!rs.length) continue
    const dm = rs.filter(r => r.context === 'dm' && r.scenario !== 'i')
    const meta = rs.reduce((a, r) => a + (r.delivered ?? []).filter(t => META_RE.test(t)).length, 0)
    lines.push(`| ${arm} | ${v} | ${rs.length} | ${rs.reduce((a, r) => a + (r.doubleSend ?? 0), 0)} | ${rs.reduce((a, r) => a + (r.narrationLeaked ?? 0), 0)} | ${rs.filter(r => r.tokenLeaked).length} | ${meta} | ${dm.filter(r => (r.delivered ?? []).length === 0 && (r.attachments ?? []).length === 0).length}/${dm.length} | ${rs.filter(r => (r.apiPaths ?? []).includes('FALLBACK_REPLY')).length} |`)
  }
  return lines.join('\n')
}
