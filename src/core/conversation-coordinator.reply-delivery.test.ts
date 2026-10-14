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
import type { AgentEvent, AgentProvider, AgentSession } from './agent-provider'
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

function setup(events: AgentEvent[], opts: { mode?: ReplyDeliveryMode; port?: ReplyDeliveryPort; extra?: Partial<ConversationCoordinatorDeps>; session?: AgentSession } = {}) {
  const registry = createProviderRegistry()
  const provider: AgentProvider = { spawn: async () => makeFakeSession({ events }) }
  registry.register('openai', provider, { displayName: 'OpenAI-compatible', canResume: () => false })
  const data = new Map<string, { mode: Mode }>([['chat-1', { mode: { kind: 'solo', provider: 'openai' } }]])
  const sendAssistantText = vi.fn(async (_c: string, _t: string) => {})
  const sendNotice = vi.fn(async (_c: string, _t: string) => {})
  const records: TurnRecord[] = []
  const logs: string[] = []
  const session = opts.session ?? makeFakeSession({ events })
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

  it('没注入 replyDeliveryModeFor ⇒ 读能力表(openai 2026-10-03 起是 daemon:由交付端口送达,不走 sendAssistantText)', async () => {
    const p = fakePort()
    const t = setup([{ kind: 'text', text: '你好' }, RESULT], { port: p.port })
    await t.c.dispatch(inbound())
    expect(p.begun.map(b => b.mode)).toEqual(['daemon'])
    expect(t.sendAssistantText).not.toHaveBeenCalled()
  })
})

describe('shadow', () => {
  it('照旧走 legacy(文字照发),另外把最后的话交给 shadow 句柄比对;TurnRecord 不填交付列', async () => {
    const p = fakePort()
    const t = setup([{ kind: 'text', text: '我查一下' }, { kind: 'tool_call', server: 'wechat', tool: 'list_projects' }, { kind: 'text', text: '你有两个项目' }, RESULT], { port: p.port, mode: 'shadow' })
    await t.c.dispatch(inbound())
    expect(t.sendAssistantText.mock.calls.map(c => c[1])).toEqual(['我查一下', '你有两个项目'])
    expect(p.begun).toEqual([{ chatId: 'chat-1', mode: 'shadow', context: 'dm', providerId: 'openai', textStrategy: 'all_segments' }])
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

/** 一个慢回合:先说一句旁白,停 `pauseMs`,再调工具、说结论。 */
function slowSession(pauseMs: number): AgentSession {
  return {
    dispatch() {
      return (async function* () {
        yield { kind: 'text', text: '我去翻翻日程' } as AgentEvent
        await new Promise(r => setTimeout(r, pauseMs))
        yield { kind: 'tool_call', server: 'wechat', tool: 'memory_read' } as AgentEvent
        yield { kind: 'text', text: '明天下午三点有会' } as AgentEvent
        yield RESULT
      })()
    },
    async close() {},
  }
}

describe('daemon(最后的话就是回复)', () => {
  it('最后一段非空文字交给端口(context=dm);legacy 出口一个字都不发;TurnRecord 记交付列', async () => {
    const p = fakePort({ delivery: 'text', bubbles: 2 })
    const t = setup([{ kind: 'text', text: '我查一下' }, { kind: 'tool_call', server: 'wechat', tool: 'list_projects' }, { kind: 'text', text: '你有两个项目' }, RESULT], { port: p.port, mode: 'daemon' })
    await t.c.dispatch(inbound())
    expect(p.begun).toEqual([{ chatId: 'chat-1', mode: 'daemon', context: 'dm', providerId: 'openai', textStrategy: 'all_segments' }])
    expect(p.delivered).toEqual([{ finalText: '你有两个项目', narration: ['我查一下'] }])
    expect(t.sendAssistantText).not.toHaveBeenCalled()
    expect(t.records[0]).toMatchObject({ outcome: 'completed', replyToolCalled: false, delivery: 'text', bubbles: 2, attachments: 0, narrationSegments: 1 })
    expect(t.logs.some(l => l.startsWith('[FALLBACK_REPLY]'))).toBe(false)
  })

  it('出错的轮:不交付残文(abandon),只发一句通知(#190 红线收紧)', async () => {
    const p = fakePort()
    const t = setup([{ kind: 'text', text: '半句话' }, { kind: 'error', message: 'step budget 25 exhausted', code: 'step_budget' }], { port: p.port, mode: 'daemon' })
    await t.c.dispatch(inbound())
    expect(p.delivered).toEqual([])
    expect(p.abandoned).toEqual(['error'])
    expect(t.sendNotice).toHaveBeenCalledTimes(1)
    expect(t.sendAssistantText).not.toHaveBeenCalled()
    expect(t.records[0]!.delivery).toBeUndefined()
  })

  it('超时的轮:abandon + 超时通知', async () => {
    const p = fakePort()
    const hang: AgentSession = { dispatch: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}), return: async () => ({ value: undefined, done: true }) }) }) as never, async close() {} }
    const t = setup([], { port: p.port, mode: 'daemon', session: hang, extra: { turnTimeoutMs: 20 } })
    await t.c.dispatch(inbound())
    expect(p.abandoned).toEqual(['timeout'])
    expect(t.sendNotice).toHaveBeenCalledWith('chat-1', expect.stringContaining('再发我一次'))
  })

  it('私聊里交付为空 / 静默 ⇒ 记「应答轮交付为空」连击;正常交付清零', async () => {
    const streaks: number[] = []
    const empty = fakePort({ delivery: 'silent', bubbles: 0 })
    const t = setup([{ kind: 'text', text: 'NO_REPLY' }, RESULT], { port: empty.port, mode: 'daemon', extra: { onEmptyReplyStreak: (_p, n) => { streaks.push(n) } } })
    await t.c.dispatch(inbound())
    await t.c.dispatch(inbound())
    expect(streaks).toEqual([1, 2])
  })

  it('长任务:超过阈值还没结束 ⇒ 发一次进度(最近一段旁白),只发一次', async () => {
    const p = fakePort()
    const t = setup([], { port: p.port, mode: 'daemon', session: slowSession(80), extra: { replyProgressAfterMs: 20, replyTextStrategyFor: () => 'last_segment' } })
    await t.c.dispatch(inbound())
    expect(p.progress).toEqual(['我去翻翻日程'])
    expect(p.delivered).toEqual([{ finalText: '明天下午三点有会', narration: ['我去翻翻日程'] }])
  })

  it('长任务还没说过话 ⇒ 进度用固定文案', async () => {
    const p = fakePort()
    const quiet: AgentSession = { dispatch: () => (async function* () { await new Promise(r => setTimeout(r, 60)); yield { kind: 'text', text: '好了' } as AgentEvent; yield RESULT })(), async close() {} }
    const t = setup([], { port: p.port, mode: 'daemon', session: quiet, extra: { replyProgressAfterMs: 15, replyTextStrategyFor: () => 'last_segment' } })
    await t.c.dispatch(inbound())
    expect(p.progress).toEqual(['还在弄,有点久,好了告诉你'])
  })

  it('很快结束的轮不发进度', async () => {
    const p = fakePort()
    const t = setup([{ kind: 'text', text: '好' }, RESULT], { port: p.port, mode: 'daemon', extra: { replyProgressAfterMs: 50 } })
    await t.c.dispatch(inbound())
    await new Promise(r => setTimeout(r, 70))
    expect(p.progress).toEqual([])
  })
})

describe('daemon × /both(parallel)', () => {
  it('daemon 的参与者只交付最后的话(带 [名字] 前缀,由 daemon 加);旁白不发', async () => {
    const registry = createProviderRegistry()
    const evs: AgentEvent[] = [{ kind: 'text', text: '我想想' }, { kind: 'tool_call', server: 'wechat', tool: 'x' }, { kind: 'text', text: '选 A' }, RESULT]
    registry.register('openai', { spawn: async () => makeFakeSession({ events: evs }) }, { displayName: 'Qwen', canResume: () => false })
    registry.register('claude', { spawn: async () => makeFakeSession({ events: evs }) }, { displayName: 'Claude', canResume: () => true })
    const p = fakePort()
    const sendAssistantText = vi.fn(async () => {})
    const c = createConversationCoordinator({
      resolveProject: () => ({ alias: 'a', path: '/p' }),
      manager: { acquire: vi.fn(async (req: { providerId: string }) => { const s = makeFakeSession({ events: evs }); return { alias: 'a', path: '/p', providerId: req.providerId, lastUsedAt: 0, dispatch: (x: string) => s.dispatch(x), close: async () => {} } }) } as never,
      conversationStore: { get: () => ({ mode: { kind: 'parallel', participants: ['openai', 'claude'] } as Mode }), set: vi.fn(), setParticipants: vi.fn() },
      registry, defaultProviderId: 'claude', format: (m) => m.text, permissionMode: 'strict',
      loadAccess: () => ({ dmPolicy: 'allowlist', allowFrom: [], admins: ['chat-1'] }), log: () => {},
      sendAssistantText, replyDelivery: p.port, replyDeliveryModeFor: (id) => id === 'openai' ? 'daemon' : 'legacy',
    })
    await c.dispatch(inbound())
    expect(p.begun).toEqual([{ chatId: 'chat-1', mode: 'daemon', context: 'parallel', providerId: 'openai', participantLabel: 'Qwen', textStrategy: 'all_segments' }])
    expect(p.delivered).toEqual([{ finalText: '选 A', narration: ['我想想'] }])
    // claude 仍是 legacy:每段一条(今天的形状)
    expect(sendAssistantText.mock.calls.map(c => (c as unknown[])[1])).toEqual(['[Claude] 我想想', '[Claude] 选 A'])
  })
})

/** /both、/chat 的扇出夹具:每家一个 provider,事件按 provider 给;交付模式按 provider 注入。 */
function fanout(kind: 'parallel' | 'chatroom', events: Record<string, AgentEvent[] | ((prompt: string) => AgentEvent[])>, modeFor: (id: string) => ReplyDeliveryMode, port: ReplyDeliveryPort, extra: Partial<ConversationCoordinatorDeps> = {}) {
  const registry = createProviderRegistry()
  const names: Record<string, string> = { openai: 'Qwen', claude: 'Claude', codex: 'Codex' }
  const ids = Object.keys(events)
  for (const id of ids) registry.register(id, { spawn: async () => makeFakeSession({ events: [] }) }, { displayName: names[id] ?? id, canResume: () => false })
  const sendAssistantText = vi.fn(async (_c: string, _t: string) => {})
  const records: TurnRecord[] = []
  const c = createConversationCoordinator({
    resolveProject: () => ({ alias: 'a', path: '/p' }),
    manager: {
      acquire: vi.fn(async (req: { providerId: string }) => {
        const ev = events[req.providerId]!
        return {
          alias: 'a', path: '/p', providerId: req.providerId, lastUsedAt: 0, close: async () => {},
          dispatch: (prompt: string) => makeFakeSession({ events: typeof ev === 'function' ? ev(prompt) : ev }).dispatch(prompt),
        }
      }),
    } as never,
    conversationStore: { get: () => ({ mode: { kind, participants: ids } as Mode }), set: vi.fn(), setParticipants: vi.fn() },
    registry, defaultProviderId: 'claude', format: (m) => m.text, permissionMode: 'strict',
    loadAccess: () => ({ dmPolicy: 'allowlist', allowFrom: [], admins: ['chat-1'] }), log: () => {},
    sendAssistantText, recordTurn: (r) => { records.push(r) },
    replyDelivery: port, replyDeliveryModeFor: modeFor, replyTextStrategyFor: (id) => id === 'openai' ? 'all_segments' : 'last_segment',
    ...extra,
  })
  return { c, sendAssistantText, records }
}

describe('/both、/chat 的 TurnRecord 记交付列(spec §4.10,和 solo 一样)', () => {
  const evs: AgentEvent[] = [{ kind: 'text', text: '我想想' }, { kind: 'tool_call', server: 'wechat', tool: 'x' }, { kind: 'text', text: '选 A' }, RESULT]

  it('/both:daemon 参与者的记录带 delivery / bubbles / attachments / narrationSegments;legacy 参与者不带', async () => {
    const p = fakePort({ delivery: 'text', bubbles: 1, attachmentsSent: 1 })
    const t = fanout('parallel', { openai: evs, claude: evs }, (id) => id === 'openai' ? 'daemon' : 'legacy', p.port)
    await t.c.dispatch(inbound())
    const byProvider = Object.fromEntries(t.records.map(r => [r.provider, r]))
    expect(t.records).toHaveLength(2)
    expect(byProvider.openai).toMatchObject({ mode: 'parallel', outcome: 'completed', delivery: 'text', bubbles: 1, attachments: 1, narrationSegments: 1 })
    expect(byProvider.claude!.delivery).toBeUndefined()
    expect(byProvider.claude).toMatchObject({ mode: 'parallel', outcome: 'completed' })
  })

  it('/both:daemon 参与者出错 ⇒ abandon、不交付,记录照样一条(不带交付列)', async () => {
    const p = fakePort()
    const t = fanout('parallel', { openai: [{ kind: 'text', text: '半句' }, { kind: 'error', message: 'boom', code: 'provider_error' }], claude: evs }, () => 'daemon', p.port)
    await t.c.dispatch(inbound())
    expect(p.abandoned).toEqual(['provider_error'])
    const rec = t.records.find(r => r.provider === 'openai')!
    expect(rec).toMatchObject({ outcome: 'error' })
    expect(rec.delivery).toBeUndefined()
    expect(t.records.find(r => r.provider === 'claude')).toMatchObject({ delivery: 'text', narrationSegments: 1 })
  })

  it('/chat:daemon 发言人经端口交付(context=chatroom、[名字] 由 daemon 加),旁白不发;#RANK 先剥掉;每一拍的记录都带交付列', async () => {
    const p = fakePort({ delivery: 'text', bubbles: 1 })
    // 互驳拍的提示里要求交 `#RANK:` 票;开场拍没有。
    const beat = (prompt: string): AgentEvent[] => prompt.includes('#RANK')
      ? [{ kind: 'text', text: '我看了一下' }, { kind: 'tool_call', server: 'x', tool: 'y' }, { kind: 'text', text: '反驳:A 忽略了成本\n#RANK: B > A' }, RESULT]
      : evs
    const t = fanout('chatroom', { claude: beat, codex: beat }, () => 'daemon', p.port)
    await t.c.dispatch(inbound('A 还是 B?'))
    // 开场两位 + 互驳两位(没有 haikuEval ⇒ 照常互驳)
    expect(p.begun.length).toBe(4)
    expect(p.begun.every(b => b.context === 'chatroom' && b.mode === 'daemon')).toBe(true)
    expect(p.begun.map(b => b.participantLabel).sort()).toEqual(['Claude', 'Claude', 'Codex', 'Codex'])
    // 开场:最后的话「选 A」,旁白「我想想」只记段数
    expect(p.delivered.slice(0, 2)).toEqual([{ finalText: '选 A', narration: ['我想想'] }, { finalText: '选 A', narration: ['我想想'] }])
    // 互驳:#RANK 行在交付之前就被剥掉
    for (const d of p.delivered.slice(2)) expect(d.finalText).toBe('反驳:A 忽略了成本')
    expect(t.sendAssistantText).not.toHaveBeenCalled()
    expect(t.records).toHaveLength(4)
    for (const r of t.records) expect(r).toMatchObject({ mode: 'chatroom', outcome: 'completed', delivery: 'text', bubbles: 1, attachments: 0, narrationSegments: 1 })
  })

  it('/chat:legacy 发言人照旧拼全部文字一条发,记录不带交付列', async () => {
    const p = fakePort()
    const t = fanout('chatroom', { claude: evs, codex: evs }, () => 'legacy', p.port)
    await t.c.dispatch(inbound('A 还是 B?'))
    expect(p.begun).toEqual([])
    expect(t.sendAssistantText.mock.calls.map(c => (c as unknown[])[1])).toContain('[Claude] 我想想\n选 A')
    for (const r of t.records) expect(r.delivery).toBeUndefined()
  })
})

describe('按执行者类型分两种策略(2026-10-03 修订)', () => {
  it('聊天型模型(all_segments):不挂长任务进度 —— 每段都会交付', async () => {
    const p = fakePort()
    const t = setup([], { port: p.port, mode: 'daemon', session: slowSession(60), extra: { replyProgressAfterMs: 15, replyTextStrategyFor: () => 'all_segments' } })
    await t.c.dispatch(inbound())
    expect(p.progress).toEqual([])
    expect(p.begun[0]).toMatchObject({ textStrategy: 'all_segments' })
  })

  it('编码型执行者(last_segment):照旧挂进度,开轮时声明策略', async () => {
    const p = fakePort()
    const t = setup([], { port: p.port, mode: 'daemon', session: slowSession(60), extra: { replyProgressAfterMs: 15, replyTextStrategyFor: () => 'last_segment' } })
    await t.c.dispatch(inbound())
    expect(p.progress).toEqual(['我去翻翻日程'])
    expect(p.begun[0]).toMatchObject({ textStrategy: 'last_segment' })
  })
})

// /stop(2026-10-10 评审):主人主动中止的一轮,既不发「脑子卡了一下」的出错通知,也不把半截话当回复交付。
// 两种 provider 行为都要覆盖:中止后报 error(openai / cursor / Claude),或中止后像正常结束一样收尾(agy / gemini)。
describe('/stop 中止的一轮(daemon)', () => {
  function stoppable(after: AgentEvent[]) {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const session: AgentSession = {
      async *dispatch() { yield { kind: 'text', text: '我先看看这个文件,接下来' } as AgentEvent; await gate; for (const e of after) yield e },
      async close() {},
    } as unknown as AgentSession
    return { session, release }
  }
  for (const [label, after] of [
    ['中止后报错', [{ kind: 'error', message: 'cancelled', code: 'cancelled' } as AgentEvent]],
    ['中止后像正常结束', [RESULT]],
  ] as const) {
    it(`${label} ⇒ 不发通知、不交付半截话、记为放弃`, async () => {
      const p = fakePort()
      const s = stoppable([...after])
      const t = setup([], { mode: 'daemon', port: p.port, session: s.session })
      const turn = t.c.dispatch(inbound())
      await new Promise(r => setTimeout(r, 10))
      expect(t.c.cancel('chat-1')).toBe(true)
      s.release()
      await turn
      expect(t.sendNotice).not.toHaveBeenCalled()
      expect(p.delivered).toEqual([])
      expect(p.abandoned).toEqual(['cancelled'])
    })
  }
})
