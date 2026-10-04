/**
 * reply-once harness 的 Codex 剧本臂(回复交付第 4 步,2026-10-03)—— **不连任何模型**。
 *
 * Codex 的真模型连 api.openai.com、用主人的 ChatGPT 登录与额度,只能小批跑(见 codex-sandbox.ts 与 harness 的
 * codex_real_* 臂)。这一臂量的是**交付管道**,不是模型:
 *
 *   同一个模型行为(同样的旁白、同样的工具、同样的话),分别用两套词汇演 ——
 *     codex_legacy:照今天的提示词用 reply / reply_voice 工具说话,codex 一轮最后照例再写一条最终消息;
 *     codex_daemon:没有 reply 族,话写在最后一条 agent_message 里,语音走附件工具 voice。
 *   对面是照 codex exec 事件形状演的假 Codex(src/core/codex-scripted.ts),这边是**生产的**全链:
 *   Codex provider(createCodexAgentProvider 的事件翻译)→ 协调器(solo)→ legacy 的 FALLBACK_REPLY /
 *   daemon 的 reply-delivery 运行时(sendText 换成记账)。
 *
 * 每个场景跑三种「外部条件」(run 序号):
 *   1 recorded  mcp_tool_call 照 SDK 0.144 的形状(server / tool),--dangerously(bypass,MCP 调用放得过);
 *   2 drift     用户的 codex CLI 比我们带的 SDK 新(2026-09-09 定案的常态),MCP 调用换了一个 SDK 不认识的 item 类型;
 *   3 strict    daemon 跑在 strict 下(没有 bypass)⇒ codex 拒掉每一次 MCP 调用(「user cancelled MCP tool call」)。
 *               只跑不需要 MCP 查询的场景(a / c / e / i);模型看得到被拒,改用文字说(脚本里的 ifRejected)。
 *
 * 场景(spec §5.8):a c d e f g h i。**b 不适用**(量的是自研循环接历史,剧本演不出)。h 比 Cursor 多一步 shell
 * (codex 查东西常顺手跑命令)—— 以前 shell 不产 tool_call,「顺便看下仓库」和结论两条消息会粘成一段。
 */
// 隔离护栏必须第一个求值(见 isolate.ts)。
import { STATE_DIR } from './isolate'
import { createConversationCoordinator, type ConversationCoordinatorDeps, type TurnRecord } from '../../../src/core/conversation-coordinator'
import { createProviderRegistry } from '../../../src/core/provider-registry'
import { createCodexAgentProvider } from '../../../src/core/codex-agent-provider'
import { createScriptedCodex, type CodexScriptedCall, type CodexScriptedTurn, type CodexScriptStep } from '../../../src/core/codex-scripted'
import { TIER_PROFILES } from '../../../src/core/user-tier'
import type { AgentEvent, PermissionMode } from '../../../src/core/agent-provider'
import type { Mode } from '../../../src/core/conversation'
import type { InboundMsg } from '../../../src/core/prompt-format'
import { extractTurnReply, type TurnTextParts } from '../../../src/core/turn-reply'
import { replyTextStrategyFor } from '../../../src/core/capability-matrix'
import { makeReplyDeliveryRuntime } from '../../../src/daemon/reply-delivery'
import { doubleSends, SPEAKING_TOOLS, type Arm, type RunResult, type Scenario } from './gate'

export const CODEX_ARMS = ['codex_legacy', 'codex_daemon'] as const
export type CodexArm = typeof CODEX_ARMS[number]
export type Variant = 'recorded' | 'drift' | 'strict'
export const VARIANTS: Variant[] = ['recorded', 'drift', 'strict']
/** 适用的场景;b 不适用(见文件头)。 */
export const CODEX_SCENARIOS: Scenario[] = ['a', 'c', 'd', 'e', 'f', 'g', 'h', 'i']
/** strict 下 MCP 调用全被拒,只跑纯说话的场景。 */
const STRICT_SCENARIOS = new Set<Scenario>(['a', 'c', 'e', 'i'])
export const variantsFor = (sc: Scenario): Variant[] => VARIANTS.filter(v => v !== 'strict' || STRICT_SCENARIOS.has(sc))

const CHAT = 'o9demo_owner@im.wechat'

// ─── 剧本:同一个模型行为,两套词汇 ─────────────────────────────────────────

const say = (s: string): CodexScriptStep => ({ say: s })
const think: CodexScriptStep = { think: '想一想怎么回' }
const mcp = (tool: string, args: Record<string, unknown> = {}, ifRejected?: CodexScriptStep[]): CodexScriptStep =>
  ({ mcp: { server: 'wechat', tool, args }, ...(ifRejected ? { ifRejected } : {}) })

/**
 * 剧本照 2026-10-03 沙盒真跑录到的形状写(results-2026-10-03-codex.jsonl / src/core/fixtures/codex-exec-2026-10-03.jsonl):
 *   - codex **在调工具之前**先写一句开场(「我发一句简短回复。」「我查一下当前登记的项目。」),不调工具就直接说答案;
 *   - legacy:正文经 reply 发出,之后照例再收一条**空的** agent_message 结束这一轮;
 *   - 被拒(strict):模型看得到 reply 失败,改用文字说(录到的原话「收到。reply 工具因审批策略被拒绝，本条通过备用通道回复。」)。
 * 两臂的开场、工具、正文一字不差;只有「怎么说出去」不同。
 */
/** 剧本里所有「工具前的开场」—— 进了微信就是旁白外泄。 */
const NARRATION = ['我发一句简短回复。', '我分三条发给你。', '我查一下当前登记的项目。', '我先确认一下语音配置。', '我先看看项目列表和记忆里的近况。', '顺便看下仓库状态。']
const speakLegacy = (text: string): CodexScriptStep[] => [mcp('reply', { chat_id: CHAT, text }, [say(text)]), say('')]

const ITEMS = ['周末去公园散散步,晒晒太阳。', '找一部想看很久的电影,窝在沙发上看完。', '约朋友吃顿饭,聊聊近况。']
const PROJECTS = '目前登记了 2 个项目:\n• wechat-cc(当前项目)\n• blog'
const H_ADVICE = '建议先推进 wechat-cc:你这周最在意回复交付重构能不能合进 dev,仓库里也还有没提交的改动;blog 已经停更两个月,可以放一放。'
const E_ANSWERS = ['在的,怎么了?', '收到,测试正常。', '收到,只回这一句。', '在的,有什么事?']
const GOODNIGHT = '晚安,今天辛苦啦。早点休息,做个好梦。'

function script(arm: CodexArm, sc: Scenario): CodexScriptedTurn[] {
  const legacy = arm === 'codex_legacy'
  // 不调工具的一句话:legacy 要调 reply,所以先有开场;daemon 没有工具可调,直接说(真机 3/3 都是这样)。
  const one = (text: string): CodexScriptedTurn => ({ steps: legacy ? [think, say('我发一句简短回复。'), ...speakLegacy(text)] : [think, say(text)] })
  switch (sc) {
    case 'a': return [one('在的,有什么事?')]
    case 'e': return E_ANSWERS.map(one)
    case 'c': return [{ steps: legacy
      ? [think, say('我分三条发给你。'), ...ITEMS.map(it => mcp('reply', { chat_id: CHAT, text: it }, [say(it)])), say('')]
      // daemon:按提示词的分条规则(空行 = 一条)写三段,一条消息(真机 3/3)。
      : [think, say(ITEMS.join('\n\n'))] }]
    case 'd': return [{ steps: [think, say('我查一下当前登记的项目。'), mcp('list_projects'), ...(legacy ? speakLegacy(PROJECTS) : [say(PROJECTS)])] }]
    // 录到的 f:先查语音配置;daemon 最后一句与语音同文 ⇒ 按已定 ⑤ 只发语音。
    case 'f': return [{ steps: [think, say('我先确认一下语音配置。'), mcp('voice_config_status'), ...(legacy
      ? [mcp('reply_voice', { chat_id: CHAT, text: GOODNIGHT }, [say(GOODNIGHT)]), say('')]
      : [mcp('voice', { text: GOODNIGHT }, [say(GOODNIGHT)]), say(GOODNIGHT)])] }]
    // 伙伴推送,议程早过期了(录到的 g:翻记忆后决定不推):legacy 的推送只认 reply 工具,不调就是不推;daemon 写 NO_REPLY。
    case 'g': return [{ steps: [think, mcp('memory_list'), mcp('memory_read', { path: `${CHAT}/profile.md` }), say(legacy ? '' : 'NO_REPLY')] }]
    case 'h': return [{ steps: [
      think, say('我先看看项目列表和记忆里的近况。'), mcp('list_projects'), mcp('memory_list'), mcp('memory_read', { path: `${CHAT}/profile.md` }),
      say('顺便看下仓库状态。'), { shell: 'git status --short', output: ' M src/core/codex-agent-provider.ts' },
      ...(legacy ? speakLegacy(H_ADVICE) : [say(H_ADVICE)]),
    ] }]
    // 私聊里诱导「不用回」:最坏的情况 —— 模型照做,只写令牌(两臂同一个输出;真机 5/5 写的是一条空消息)。
    case 'i': return [{ steps: [think, say('NO_REPLY')] }]
    default: throw new Error(`codex 剧本臂不跑场景 ${sc}(见文件头:b 不适用)`)
  }
}

// ─── 一次运行 ────────────────────────────────────────────────────────────

interface Sent { kind: 'text' | 'voice'; text: string }

export async function runOnceCodexFixture(arm: CodexArm, scenario: Scenario, variant: Variant, run: number): Promise<RunResult> {
  const started = Date.now()
  const daemon = arm === 'codex_daemon'
  const permissionMode: PermissionMode = variant === 'strict' ? 'strict' : 'dangerously'
  let sent: Sent[] = []
  const calls: CodexScriptedCall[] = []
  const logs: string[] = []
  const rt = makeReplyDeliveryRuntime({
    sendText: async (_c, t) => { sent.push({ kind: 'text', text: t }); return { msgId: `m${sent.length}` } },
    sleep: async () => {},
    log: (tag) => { logs.push(tag) },
  })
  // MCP server 那一侧:legacy 的 reply / reply_voice 路由立刻发进微信;daemon 的 voice 挂到本轮(交付时才发)。
  const onToolCall = (call: CodexScriptedCall) => {
    calls.push(call)
    const text = String(call.args.text ?? '')
    if (call.tool === 'reply') sent.push({ kind: 'text', text })
    else if (call.tool === 'reply_voice') sent.push({ kind: 'voice', text })
    else if (call.tool === 'voice') rt.attach(CHAT, { attachment: { kind: 'voice', text }, send: async () => { sent.push({ kind: 'voice', text }); return { ok: true } } })
  }
  const turns = script(arm, scenario)
  const scripted = createScriptedCodex({ turns, onToolCall, mcpItem: variant === 'drift' ? 'unknown_item' : 'mcp_tool_call' })
  const provider = createCodexAgentProvider({ codexFactory: scripted.factory, dangerouslyBypassApprovalsAndSandbox: permissionMode === 'dangerously', timeouts: { firstEventTimeoutMs: 10_000, connectTimeoutMs: 10_000 } })
  const session = await provider.spawn({ alias: 'demo', path: STATE_DIR }, { tierProfile: TIER_PROFILES.admin, permissionMode, chatId: CHAT })
  const textStrategy = replyTextStrategyFor('codex')
  try {
    // g:伙伴推送不走协调器(tick-bodies 的 dispatchToChat):legacy 只认 reply 工具;daemon 走同一个交付运行时,场合 tick。
    if (scenario === 'g') {
      const handle = daemon ? rt.begin(CHAT, { mode: 'daemon', context: 'tick', providerId: 'codex', textStrategy }) : undefined
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
    registry.register('codex', provider, { displayName: 'Codex', canResume: () => true })
    const data = new Map<string, { mode: Mode }>([[CHAT, { mode: { kind: 'solo', provider: 'codex' } }]])
    const c = createConversationCoordinator({
      resolveProject: () => ({ alias: 'demo', path: STATE_DIR }),
      manager: {
        acquire: async () => ({ alias: 'demo', path: STATE_DIR, providerId: 'codex', lastUsedAt: 0, dispatch: (t: string) => session.dispatch(t), cancel: async () => { await session.cancel?.() }, close: async () => {} }),
        release: async () => {},
      } as unknown as ConversationCoordinatorDeps['manager'],
      conversationStore: { get: (id: string) => data.get(id) ?? null, set: () => {}, setParticipants: () => {} },
      registry,
      defaultProviderId: 'codex',
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
  calls: CodexScriptedCall[]; logs: string[]; started: number; context: 'dm' | 'tick'; silent: boolean; completed: boolean
  textStrategy?: 'last_segment' | 'all_segments'; warmup?: RunResult['warmup']
}): RunResult {
  const final = x.parts.finalText.trim()
  // 旁白 = 剧本里工具前的开场(两臂一字不差)。legacy 的「最后一段」常常就是开场本身(reply 之后那条消息是空的),
  // 所以不能用 extractTurnReply 的 narration 来数 —— 直接数剧本里的开场有几句进了微信。
  const narration = [...new Set([...NARRATION, ...x.parts.narration.map(n => n.trim()).filter(n => n.length >= 4 && n !== final)])]
  const err = x.evs.find(e => e.kind === 'error') as Extract<AgentEvent, { kind: 'error' }> | undefined
  return {
    arm: x.arm, scenario: x.scenario, run: x.run,
    replies: x.calls.filter(c => c.tool === 'reply' || c.tool === 'reply_voice').map(c => String(c.args.text ?? '')),
    // 非回复工具:真被调用的 MCP 工具 + shell 这类内置工具(从事件里数)。
    nonReplyTools: [
      ...x.calls.map(c => c.tool).filter(t => !SPEAKING_TOOLS.has(t)),
      ...x.evs.filter((e): e is Extract<AgentEvent, { kind: 'tool_call' }> => e.kind === 'tool_call' && e.server === undefined && e.tool === 'shell').map(e => e.tool),
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
export async function runCodexFixtureGate(arms: readonly CodexArm[] = CODEX_ARMS, scenarios: readonly Scenario[] = CODEX_SCENARIOS): Promise<RunResult[]> {
  const rows: RunResult[] = []
  for (const arm of arms) for (const sc of scenarios) {
    const vs = variantsFor(sc)
    for (let i = 0; i < vs.length; i++) rows.push(await runOnceCodexFixture(arm, sc, vs[i]!, i + 1))
  }
  return rows
}

/** 按外部条件拆开的双发 / 旁白外泄 / 什么都没收到(只有 dm 场景)。 */
export function byVariant(rows: readonly RunResult[]): string {
  const lines = ['| arm | 外部条件 | 轮数 | 双发 | 旁白外泄 | 令牌外泄 | 主人什么都没收到(私聊、非 i) | FALLBACK_REPLY |', '|---|---|---|---|---|---|---|---|']
  for (const arm of CODEX_ARMS) for (const v of VARIANTS) {
    const rs = rows.filter(r => r.arm === arm && (r.apiPaths ?? []).includes(`variant:${v}`))
    if (!rs.length) continue
    const dm = rs.filter(r => r.context === 'dm' && r.scenario !== 'i')
    lines.push(`| ${arm} | ${v} | ${rs.length} | ${rs.reduce((a, r) => a + (r.doubleSend ?? 0), 0)} | ${rs.reduce((a, r) => a + (r.narrationLeaked ?? 0), 0)} | ${rs.filter(r => r.tokenLeaked).length} | ${dm.filter(r => (r.delivered ?? []).length === 0 && (r.attachments ?? []).length === 0).length}/${dm.length} | ${rs.filter(r => (r.apiPaths ?? []).includes('FALLBACK_REPLY')).length} |`)
  }
  return lines.join('\n')
}
