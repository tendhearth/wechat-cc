/**
 * 回复交付(spec 2026-10-03-reply-delivery)在协调器上的接线:
 *  - 系统通知走 sendNotice(与 agent 的话分家)
 *  - legacy:端口接了也不碰(第 0 步不改任何人的行为)
 *  - shadow:照旧 legacy,另外 begin('shadow') → deliver(最后的话) 只记账
 *  - daemon:最后的话经端口交付;不完成的轮只发通知;私聊里空 / 静默计入连击
 */
import { describe, expect, it, vi } from 'vitest'
import { createConversationCoordinator, type TurnRecord, type ConversationCoordinatorDeps } from './conversation-coordinator'
import { createProviderRegistry } from './provider-registry'
import { makeFakeSession } from './test-helpers'
import type { AgentEvent, AgentProvider } from './agent-provider'
import type { Mode } from './conversation'
import type { InboundMsg } from './prompt-format'
import type { DeliveryReport, ReplyDeliveryMode, ReplyDeliveryPort, TurnDeliveryHandle, TurnTextParts } from './turn-reply'

const RESULT: AgentEvent = { kind: 'result', sessionId: 's', numTurns: 1, durationMs: 1 }

function inbound(text = 'hi'): InboundMsg {
  return { chatId: 'chat-1', userId: 'chat-1', text, msgType: 'text', createTimeMs: Date.now(), accountId: 'acct' }
}

function fakePort(report: Partial<DeliveryReport> = {}) {
  const begun: Array<{ chatId: string; mode: string; context: string; providerId: string; participantLabel?: string }> = []
  const delivered: TurnTextParts[] = []
  const abandoned: string[] = []
  const progress: string[] = []
  const port: ReplyDeliveryPort = {
    begin(chatId, opts) {
      begun.push({ chatId, ...opts })
      const h: TurnDeliveryHandle = {
        mode: opts.mode,
        async progress(t) { progress.push(t) },
        async deliver(parts) {
          delivered.push(parts)
          return { delivery: 'text', target: 'wechat', bubbles: 1, attachmentsSent: 0, failures: [], msgIds: ['m1'], ...(opts.mode === 'shadow' ? { shadow: true } : {}), ...report }
        },
        abandon(reason) { abandoned.push(reason) },
      }
      return h
    },
  }
  return { port, begun, delivered, abandoned, progress }
}

function setup(events: AgentEvent[], opts: { mode?: ReplyDeliveryMode; port?: ReplyDeliveryPort; extra?: Partial<ConversationCoordinatorDeps> } = {}) {
  const registry = createProviderRegistry()
  const provider: AgentProvider = { spawn: async () => makeFakeSession({ events }) }
  registry.register('openai', provider, { displayName: 'OpenAI-compatible', canResume: () => false })
  const data = new Map<string, { mode: Mode }>([['chat-1', { mode: { kind: 'solo', provider: 'openai' } }]])
  const sendAssistantText = vi.fn(async (_c: string, _t: string) => {})
  const sendNotice = vi.fn(async (_c: string, _t: string) => {})
  const records: TurnRecord[] = []
  const logs: string[] = []
  const session = makeFakeSession({ events })
  const c = createConversationCoordinator({
    resolveProject: () => ({ alias: 'a', path: '/p' }),
    manager: {
      acquire: vi.fn(async () => ({
        alias: 'a', path: '/p', providerId: 'openai', lastUsedAt: 0,
        dispatch: (t: string) => session.dispatch(t), cancel: async () => {}, close: async () => {},
      })),
      release: vi.fn(async () => {}),
    } as unknown as ConversationCoordinatorDeps['manager'],
    conversationStore: { get: (id: string) => data.get(id) ?? null, set: vi.fn(), setParticipants: vi.fn() },
    registry,
    defaultProviderId: 'openai',
    format: (m) => m.text,
    permissionMode: 'strict',
    loadAccess: () => ({ dmPolicy: 'allowlist', allowFrom: [], admins: ['chat-1'] }),
    log: (tag, line) => { logs.push(`[${tag}] ${line}`) },
    sendAssistantText,
    sendNotice,
    recordTurn: (r) => { records.push(r) },
    ...(opts.port ? { replyDelivery: opts.port } : {}),
    ...(opts.mode ? { replyDeliveryModeFor: () => opts.mode! } : {}),
    ...opts.extra,
  })
  return { c, sendAssistantText, sendNotice, records, logs }
}

describe('系统通知分家(sendNotice)', () => {
  it('本轮出错且没有文字 ⇒ 通知走 sendNotice,不走 sendAssistantText', async () => {
    const t = setup([{ kind: 'error', message: 'boom' }])
    await t.c.dispatch(inbound())
    expect(t.sendNotice).toHaveBeenCalledTimes(1)
    expect(t.sendAssistantText).not.toHaveBeenCalled()
  })

  it('没接 sendNotice ⇒ 退回 sendAssistantText(老嵌入不变)', async () => {
    const t = setup([{ kind: 'error', message: 'boom' }], { extra: { sendNotice: undefined } })
    await t.c.dispatch(inbound())
    expect(t.sendAssistantText).toHaveBeenCalledTimes(1)
  })
})

describe('legacy(第 0 步的默认)', () => {
  it('端口接了也不碰;没调 reply 的文字照旧 FALLBACK_REPLY', async () => {
    const p = fakePort()
    const t = setup([{ kind: 'text', text: '你好' }, RESULT], { port: p.port, mode: 'legacy' })
    await t.c.dispatch(inbound())
    expect(p.begun).toEqual([])
    expect(t.sendAssistantText).toHaveBeenCalledWith('chat-1', '你好')
    expect(t.records[0]!.delivery).toBeUndefined()
  })

  it('没注入 replyDeliveryModeFor ⇒ 读能力表,默认 legacy', async () => {
    const p = fakePort()
    const t = setup([{ kind: 'text', text: '你好' }, RESULT], { port: p.port })
    await t.c.dispatch(inbound())
    expect(p.begun).toEqual([])
  })
})

describe('shadow', () => {
  it('照旧走 legacy(文字照发),另外把最后的话交给 shadow 句柄比对;TurnRecord 不填交付列', async () => {
    const p = fakePort()
    const t = setup([{ kind: 'text', text: '我查一下' }, { kind: 'tool_call', server: 'wechat', tool: 'list_projects' }, { kind: 'text', text: '你有两个项目' }, RESULT], { port: p.port, mode: 'shadow' })
    await t.c.dispatch(inbound())
    expect(t.sendAssistantText.mock.calls.map(c => c[1])).toEqual(['我查一下', '你有两个项目'])
    expect(p.begun).toEqual([{ chatId: 'chat-1', mode: 'shadow', context: 'dm', providerId: 'openai' }])
    expect(p.delivered).toEqual([{ finalText: '你有两个项目', narration: ['我查一下'] }])
    expect(t.records[0]!.delivery).toBeUndefined()
  })

  it('出错的轮 ⇒ shadow 只 abandon,不比', async () => {
    const p = fakePort()
    const t = setup([{ kind: 'text', text: '半句' }, { kind: 'error', message: 'x' }], { port: p.port, mode: 'shadow' })
    await t.c.dispatch(inbound())
    expect(p.delivered).toEqual([])
    expect(p.abandoned).toEqual(['error'])
  })

  it('shadow 句柄抛错也不影响这一轮', async () => {
    const port: ReplyDeliveryPort = { begin: () => ({ mode: 'shadow', progress: async () => {}, deliver: async () => { throw new Error('bad') }, abandon: () => {} }) }
    const t = setup([{ kind: 'text', text: '你好' }, RESULT], { port, mode: 'shadow' })
    await expect(t.c.dispatch(inbound())).resolves.toBeUndefined()
    expect(t.sendAssistantText).toHaveBeenCalledWith('chat-1', '你好')
    expect(t.records).toHaveLength(1)
  })
})
