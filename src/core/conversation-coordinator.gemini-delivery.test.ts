/**
 * 回复交付收尾前的「gemini 二选一」(spec §5.7,2026-10-04 定:迁到 daemon)。
 *
 * gemini(API key 版,2026-09-27 起 deprecated)和 openai 是同一种形状:我们自己的循环(没有 functionCall 的那一步
 * 就是一轮的结束),聊天型模型 ⇒ `all_segments`。主人机器上从没配过 GEMINI_API_KEY,真模型闸门做不了;这里用
 * 生产的 gemini 循环(createGeminiAgentProvider + 剧本 genai)+ 生产的协调器 + 生产的交付运行时
 * (makeReplyDeliveryRuntime,只假 sendText)证明交付管道:读能力表默认值(不注入模式)就走 daemon。
 */
import { describe, expect, it, vi } from 'vitest'
import { createConversationCoordinator, type ConversationCoordinatorDeps, type TurnRecord } from './conversation-coordinator'
import { createProviderRegistry } from './provider-registry'
import { createGeminiAgentProvider } from './gemini-agent-provider'
import { TIER_PROFILES } from './user-tier'
import type { Mode } from './conversation'
import type { InboundMsg } from './prompt-format'
import { makeReplyDeliveryRuntime } from '../daemon/reply-delivery'

type GenaiStep = { text?: string; functionCalls?: Array<{ name: string; args?: Record<string, unknown> }> } | Error

function setup(steps: GenaiStep[], tools: string[] = ['list_projects', 'voice', 'sticker', 'attach_file', 'message']) {
  let i = 0
  const toolCalls: string[] = []
  const provider = createGeminiAgentProvider({
    genai: { models: { async generateContent() { const s = steps[i++] ?? { text: '' }; if (s instanceof Error) throw s; return s } } } as never,
    model: 'gemini-flash-latest',
    systemInstruction: 'x',
    async mcpConnect() {
      return {
        listTools: async () => tools.map(name => ({ name, inputSchema: { type: 'object', properties: {} } })),
        callTool: async (name: string) => { toolCalls.push(name); return { content: [{ type: 'text', text: '{"ok":true}' }] } },
        close: async () => {},
      }
    },
    buildGate: () => async () => ({ allow: true }),
  })
  const registry = createProviderRegistry()
  registry.register('gemini', provider, { displayName: 'Gemini', canResume: () => false })
  const data = new Map<string, { mode: Mode }>([['chat-1', { mode: { kind: 'solo', provider: 'gemini' } }]])
  const sent: string[] = []
  const logs: string[] = []
  const records: TurnRecord[] = []
  const sendAssistantText = vi.fn(async (_c: string, _t: string) => {})
  const sendNotice = vi.fn(async (_c: string, _t: string) => {})
  const runtime = makeReplyDeliveryRuntime({
    sendText: async (_c, t) => { sent.push(t); return { msgId: `m${sent.length}` } },
    sleep: async () => {},
    log: (tag, l) => { logs.push(`[${tag}] ${l}`) },
  })
  const c = createConversationCoordinator({
    resolveProject: () => ({ alias: 'a', path: '/p' }),
    manager: {
      acquire: vi.fn(async () => {
        const s = await provider.spawn({ alias: 'a', path: '/p' }, { tierProfile: TIER_PROFILES.admin, permissionMode: 'strict', chatId: 'chat-1' })
        return { alias: 'a', path: '/p', providerId: 'gemini', lastUsedAt: 0, dispatch: (t: string) => s.dispatch(t), cancel: async () => {}, close: async () => {} }
      }),
      release: vi.fn(async () => {}),
    } as unknown as ConversationCoordinatorDeps['manager'],
    conversationStore: { get: (id: string) => data.get(id) ?? null, set: vi.fn(), setParticipants: vi.fn() },
    registry,
    defaultProviderId: 'gemini',
    format: (m) => m.text,
    permissionMode: 'strict',
    loadAccess: () => ({ dmPolicy: 'allowlist', allowFrom: [], admins: ['chat-1'] }),
    log: (tag, l) => { logs.push(`[${tag}] ${l}`) },
    sendAssistantText,
    sendNotice,
    recordTurn: (r) => { records.push(r) },
    replyDelivery: runtime,
    // 不注入 replyDeliveryModeFor / replyTextStrategyFor:读能力表的默认值。
  })
  return { c, sent, logs, records, sendAssistantText, sendNotice, toolCalls }
}

const msg = (): InboundMsg => ({ chatId: 'chat-1', userId: 'chat-1', text: '我有哪些项目?', msgType: 'text', createTimeMs: Date.now(), accountId: 'acct' })

describe('gemini → daemon(能力表默认值,2026-10-04)', () => {
  it('工具前后的文字段都交付(聊天型 all_segments),各一条;没有 FALLBACK_REPLY;TurnRecord 记交付列', async () => {
    const t = setup([
      { text: '我查一下你登记的项目。', functionCalls: [{ name: 'list_projects' }] },
      { text: '你有两个项目:wechat-cc 和 blog。' },
    ])
    await t.c.dispatch(msg())
    expect(t.toolCalls).toEqual(['list_projects'])
    expect(t.sent).toEqual(['我查一下你登记的项目。', '你有两个项目:wechat-cc 和 blog。'])
    expect(t.sendAssistantText).not.toHaveBeenCalled()
    expect(t.logs.some(l => l.startsWith('[FALLBACK_REPLY]'))).toBe(false)
    expect(t.records[0]).toMatchObject({ provider: 'gemini', outcome: 'completed', replyToolCalled: false, delivery: 'text', bubbles: 2, attachments: 0 })
  })

  it('私聊里写 NO_REPLY ⇒ 不显示令牌、什么都不发,记 REPLY_SILENT_IN_DM', async () => {
    const t = setup([{ text: 'NO_REPLY' }])
    await t.c.dispatch(msg())
    expect(t.sent).toEqual([])
    expect(t.logs.some(l => l.startsWith('[REPLY_SILENT_IN_DM]'))).toBe(true)
    expect(t.records[0]).toMatchObject({ delivery: 'silent', bubbles: 0 })
  })

  it('循环中途出错 ⇒ 半截文字不交付,只发一句通知(#190 红线)', async () => {
    const t = setup([{ text: '我先看看', functionCalls: [{ name: 'list_projects' }] }, new Error('503 UNAVAILABLE')])
    await t.c.dispatch(msg())
    expect(t.sent).toEqual([])
    expect(t.sendNotice).toHaveBeenCalledTimes(1)
    expect(t.records[0]!.outcome).toBe('error')
    expect(t.records[0]!.delivery).toBeUndefined()
  })
})
