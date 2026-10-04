/**
 * 回复交付第 2 步(agy → daemon):agy「双发旁白」在 daemon 模式下**结构性**消失的证明。
 *
 * 2026-09-08 真机:agy 用 reply 工具发了正文,又写一句旁白「已回复用户的问候。」。协调器靠 server 名认
 * reply 调用,agy 回报的是命名空间键,认不出 ⇒ replyToolCalled=false ⇒ FALLBACK_REPLY 把旁白当第二条发出去。
 * 当时的修法是把命名空间折回 `wechat` —— 但那是「把这一家的 tool_call 形状认对」:下一次 CLI 换个
 * envelope / 命名空间键,双发就悄悄回来(下面 legacy 那条用一个没登记的命名空间复现)。
 *
 * daemon 模式下说话只有一条路:这一轮写下的文字由 daemon 交付一次。协调器**不再看** tool_call 认不认得出来
 * (没有 FALLBACK_REPLY,也没有 reply 工具可以先发一遍)—— 所以 server 名是什么都无所谓。
 * 事件走真的 agy NDJSON 解析器(createAgyAgentProvider + 假 spawn),形状照 agy-agent-provider.test 的 fixture。
 */
import { describe, expect, it, vi } from 'vitest'
import { createConversationCoordinator, type ConversationCoordinatorDeps, type TurnRecord } from './conversation-coordinator'
import { createProviderRegistry } from './provider-registry'
import { createAgyAgentProvider } from './agy-agent-provider'
import { TIER_PROFILES } from './user-tier'
import type { Mode } from './conversation'
import type { InboundMsg } from './prompt-format'
import type { DeliveryReport, ReplyDeliveryMode, ReplyDeliveryPort, TurnTextParts } from './turn-reply'
import { buildTurnReply } from './turn-reply'

const C = 'c1'
const line = (o: unknown) => JSON.stringify(o)
const INIT = line({ event: 'init', conversation_id: C, init: { model: 'm', tools: [], permission_mode: 'request-review' } })
const say = (i: number, text: string) => line({ event: 'step_update', step_update: { conversation_id: C, step_index: i, state: 'DONE', step_type: 'agent_response', text_delta: text } })
const mcp = (i: number, server: string, tool: string, args: Record<string, unknown>) => line({
  event: 'step_update',
  step_update: { conversation_id: C, step_index: i, state: 'ACTIVE', step_type: 'tool', tool_name: 'call_mcp_tool', tool_info: { name: 'call_mcp_tool', parameters: { Arguments: args, ServerName: server, ToolName: tool } } },
})
const DONE = line({ event: 'result', result: { conversation_id: C, status: 'SUCCESS', response: '', num_turns: 1 } })

/** 一个没登记过的命名空间键 —— 「下一版 CLI 换了形状」。 */
const FUTURE_NS = 'wechat-cc-next'

function setup(lines: string[], mode: ReplyDeliveryMode) {
  const spawnFn = () => ({
    stdout: (async function* () { for (const l of lines) yield l + '\n' })(),
    exited: Promise.resolve(0),
    stderr: async () => '',
    kill: () => {},
  })
  const provider = createAgyAgentProvider({ bin: 'agy', model: 'm', spawnFn, log: () => {} })
  const registry = createProviderRegistry()
  registry.register('agy', provider, { displayName: 'Gemini (agy)', canResume: () => true })
  const data = new Map<string, { mode: Mode }>([['chat-1', { mode: { kind: 'solo', provider: 'agy' } }]])
  const sendAssistantText = vi.fn(async (_c: string, _t: string) => {})
  const sendNotice = vi.fn(async (_c: string, _t: string) => {})
  const logs: string[] = []
  const records: TurnRecord[] = []
  // 交付端口:真的 buildTurnReply(按 agy 的 all_segments 策略),记下「会发出去的每一段」。
  const delivered: string[][] = []
  const begun: string[] = []
  const port: ReplyDeliveryPort = {
    begin(_chatId, opts) {
      begun.push(`${opts.mode}:${opts.providerId}:${opts.textStrategy}`)
      return {
        mode: opts.mode,
        async progress() {},
        async deliver(parts: TurnTextParts): Promise<DeliveryReport> {
          const { reply } = buildTurnReply(parts, [], opts.context, opts.textStrategy)
          delivered.push(reply.segments ?? [reply.text])
          return { delivery: 'text', target: 'wechat', bubbles: reply.segments?.length ?? 1, attachmentsSent: 0, failures: [], msgIds: [] }
        },
        abandon() {},
      }
    },
  }
  const c = createConversationCoordinator({
    resolveProject: () => ({ alias: 'a', path: '/p' }),
    manager: {
      acquire: vi.fn(async () => {
        const s = await provider.spawn({ alias: 'a', path: '/p' }, { tierProfile: TIER_PROFILES.trusted, permissionMode: 'strict', chatId: 'chat-1' })
        return { alias: 'a', path: '/p', providerId: 'agy', lastUsedAt: 0, dispatch: (t: string) => s.dispatch(t), cancel: async () => {}, close: async () => {} }
      }),
      release: vi.fn(async () => {}),
    } as unknown as ConversationCoordinatorDeps['manager'],
    conversationStore: { get: (id: string) => data.get(id) ?? null, set: vi.fn(), setParticipants: vi.fn() },
    registry,
    defaultProviderId: 'agy',
    format: (m) => m.text,
    permissionMode: 'strict',
    loadAccess: () => ({ dmPolicy: 'allowlist', allowFrom: [], admins: ['chat-1'] }),
    log: (tag, l) => { logs.push(`[${tag}] ${l}`) },
    sendAssistantText,
    sendNotice,
    recordTurn: (r) => { records.push(r) },
    replyDelivery: port,
    replyDeliveryModeFor: () => mode,
  })
  return { c, sendAssistantText, sendNotice, logs, records, delivered, begun }
}

const msg = (): InboundMsg => ({ chatId: 'chat-1', userId: 'chat-1', text: '你好', msgType: 'text', createTimeMs: Date.now(), accountId: 'acct' })

describe('agy:双发旁白在 daemon 模式下结构性消失', () => {
  it('legacy(对照,复现根因):reply 调用的命名空间认不出来 ⇒ FALLBACK_REPLY 把旁白当第二条发出去', async () => {
    // reply 工具已经把「你好呀～」发出去了(这里只看协调器的那一半),模型又写了一句旁白。
    const t = setup([INIT, mcp(1, FUTURE_NS, 'reply', { chat_id: 'chat-1', text: '你好呀～' }), say(2, '已回复用户的问候。'), DONE], 'legacy')
    await t.c.dispatch(msg())
    expect(t.logs.some(l => l.startsWith('[FALLBACK_REPLY]'))).toBe(true)
    expect(t.sendAssistantText).toHaveBeenCalledWith('chat-1', '已回复用户的问候。') // 主人收到第二条
    expect(t.begun).toEqual([])
  })

  it('daemon:同样是认不出的命名空间,话只经 daemon 交付一次;没有 FALLBACK_REPLY,不碰 sendAssistantText', async () => {
    // daemon 模式下 agy 没有 reply 工具;它写下的话就是回复,附件工具(这里 voice)走哪个 server 名都一样。
    const t = setup([INIT, say(1, '你好呀～'), mcp(2, FUTURE_NS, 'voice', { text: '你好呀' }), say(3, '今天过得怎么样?'), DONE], 'daemon')
    await t.c.dispatch(msg())
    expect(t.begun).toEqual(['daemon:agy:all_segments'])
    expect(t.delivered).toEqual([['你好呀～', '今天过得怎么样?']])
    expect(t.sendAssistantText).not.toHaveBeenCalled()
    expect(t.logs.some(l => l.startsWith('[FALLBACK_REPLY]'))).toBe(false)
    expect(t.records[0]).toMatchObject({ provider: 'agy', outcome: 'completed', delivery: 'text', replyToolCalled: false })
  })

  it('daemon:server 名认得出 / 认不出,交付结果一字不差(交付不依赖认出 tool_call)', async () => {
    const run = async (ns: string) => {
      const t = setup([INIT, say(1, '我看看'), mcp(2, ns, 'list_projects', {}), say(3, '你有两个项目:wechat-cc 和 blog。'), DONE], 'daemon')
      await t.c.dispatch(msg())
      return t.delivered
    }
    expect(await run('wechat-cc-wechat')).toEqual(await run(FUTURE_NS))
  })

  it('daemon:出错的轮只发通知,半截文字不交付(#190 红线,agy 的 status≠SUCCESS)', async () => {
    const ERR = line({ event: 'result', result: { conversation_id: C, status: 'ERROR', error: 'quota', response: '', num_turns: 1 } })
    const t = setup([INIT, say(1, '我先查一下'), ERR], 'daemon')
    await t.c.dispatch(msg())
    expect(t.delivered).toEqual([])
    expect(t.sendNotice).toHaveBeenCalledTimes(1)
    expect(t.sendAssistantText).not.toHaveBeenCalled()
  })
})
