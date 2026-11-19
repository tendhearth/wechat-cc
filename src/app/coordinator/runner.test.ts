import { describe, expect, it, vi } from 'vitest'
import { createTurnRunner } from './runner'
import { createCoordinatorCtx, type CoordinatorCtx } from './ctx'
import type { AgentEvent } from '../../ports/agent-provider'
import type { ChatTurnHandle, ChatTurnLog } from '../../ports/chat-turns'

/** runner 把对话的一轮记进这件对话(M3a):run 开、record 收,两边按调用方给的 turn 对象对上;没走到 run 的也记一轮。 */
function harness() {
  const opened: Array<{ provider: string; startedAt: number; events: AgentEvent[]; ends: unknown[] }> = []
  const chatTurns: ChatTurnLog = {
    begin: t => {
      const rec = { provider: t.provider, startedAt: t.startedAt, events: [] as AgentEvent[], ends: [] as unknown[] }
      opened.push(rec)
      const h: ChatTurnHandle = { event: ev => { rec.events.push(ev) }, end: r => { rec.ends.push(r) } }
      return h
    },
    interruptAll: () => {},
  }
  const recordTurn = vi.fn()
  const deps = { chatTurns, recordTurn, log: vi.fn() } as unknown as CoordinatorCtx['deps']
  const runner = createTurnRunner(createCoordinatorCtx(deps))
  const handle = (events: AgentEvent[]) => ({ dispatch: () => (async function* () { for (const e of events) yield e })() })
  return { runner, opened, recordTurn, handle }
}
const RESULT: AgentEvent = { kind: 'result', sessionId: 's', numTurns: 1, durationMs: 1 }

describe('runner · 对话的轮(M3a)', () => {
  it('user coordinator marks each dispatch as inbound for permission prompts', async () => {
    const { runner } = harness()
    const dispatch = vi.fn(() => (async function* () { yield RESULT })())
    const summary = await runner.run({ chatId: 'owner', alias: 'a', providerId: 'openai', handle: { dispatch }, prompt: 'hand off', budget: 'turn' })
    expect(summary.result?.sessionId).toBe('s')
    expect(dispatch).toHaveBeenCalledWith('hand off', { source: 'inbound' })
  })
  it('只向事项事件流写入重答后的文字，保留已执行的工具事件', async () => {
    const { runner, opened, handle } = harness()
    const tool: AgentEvent = { kind: 'tool_call', tool: 'Read' }
    const answer: AgentEvent = { kind: 'text', text: '已经查好了。' }
    const dispatch = vi.fn()
      .mockImplementationOnce(handle([tool, { kind: 'text', text: '[Sys', itemId: 'item', textMode: 'replace' }, { kind: 'text', text: '[System: echo]', itemId: 'item', textMode: 'replace' }, RESULT]).dispatch)
      .mockImplementationOnce(handle([answer, RESULT]).dispatch)
    const summary = await runner.run({ chatId: 'c', alias: 'a', providerId: 'openai', handle: { dispatch }, prompt: 'hi', budget: 'turn', startedAt: 100, turn: {} })
    expect(opened[0]!.events).toEqual([tool, RESULT, answer, RESULT])
    expect(summary).toMatchObject({ replyRetried: true, finalText: '已经查好了。', toolCalls: ['Read'] })
    expect(dispatch).toHaveBeenLastCalledWith('上一条不是给主人的话。请直接用平常话回答主人刚才那句。', { source: 'background' })
  })

  it.each(['turn', 'beat'] as const)('%s:一直有动静的长轮次不被掐断(看门狗只管多久没动静,不管总时长)', async budget => {
    vi.useFakeTimers()
    try {
      const runner = createTurnRunner(createCoordinatorCtx({ turnTimeoutMs: 100, log: vi.fn() } as unknown as CoordinatorCtx['deps']))
      // 总共 300ms,远超 100ms 的看门狗,但每 60ms 就有一个事件
      const dispatch = vi.fn(async function* (): AsyncGenerator<AgentEvent> {
        for (let i = 0; i < 5; i++) { await new Promise(resolve => setTimeout(resolve, 60)); yield { kind: 'tool_call', tool: 'Read' } }
        yield { kind: 'text', text: '查完了。' }
        yield RESULT
      })
      const run = runner.run({ chatId: 'c', alias: 'a', providerId: 'claude', handle: { dispatch }, prompt: 'hi', budget })
      await vi.advanceTimersByTimeAsync(400)
      const summary = await run
      expect(summary.errorCode).toBeUndefined()
      expect(summary).toMatchObject({ finalText: '查完了。', replyRetried: false })
      expect(dispatch).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })

  it.each(['turn', 'beat'] as const)('%s:重答有自己的硬上限,一直在说也到点收', async budget => {
    vi.useFakeTimers()
    try {
      const runner = createTurnRunner(createCoordinatorCtx({ turnTimeoutMs: 100, log: vi.fn() } as unknown as CoordinatorCtx['deps']))
      const dispatch = vi.fn()
        .mockImplementationOnce(async function* (): AsyncGenerator<AgentEvent> {
          // 第一轮本身很长(240ms)但一直有动静:不该被掐,也不该吃掉重答的时间
          for (let i = 0; i < 4; i++) { await new Promise(resolve => setTimeout(resolve, 60)); yield { kind: 'tool_call', tool: 'Read' } }
          yield { kind: 'text', text: '[System: echo]' }
        })
        .mockImplementationOnce(async function* (): AsyncGenerator<AgentEvent> {
          for (;;) { await new Promise(resolve => setTimeout(resolve, 60)); yield { kind: 'text', text: '半句' } }
        })
      const done = vi.fn()
      const run = runner.run({ chatId: 'c', alias: 'a', providerId: 'claude', handle: { dispatch }, prompt: 'hi', budget }).then(done)
      await vi.advanceTimersByTimeAsync(240 + 99)
      expect(done).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(60)
      await run
      expect(dispatch).toHaveBeenCalledTimes(2)
      expect(done).toHaveBeenCalledWith(expect.objectContaining({ replyRetried: true, errorCode: 'turn_timeout' }))
    } finally { vi.useRealTimers() }
  })

  it('这一轮已经被叫停 ⇒ 不开始重答', async () => {
    const abort = new AbortController()
    const log = (tag: string) => { if (tag === 'REPLY_NOT_FOR_OWNER') abort.abort() }
    const runner = createTurnRunner(createCoordinatorCtx({ log } as unknown as CoordinatorCtx['deps']))
    const dispatch = vi.fn(async function* (): AsyncGenerator<AgentEvent> { yield { kind: 'text', text: '[System: echo]' } })
    const summary = await runner.run({ chatId: 'c', alias: 'a', providerId: 'claude', handle: { dispatch }, prompt: 'hi', budget: 'turn', signal: abort.signal })
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(summary).toMatchObject({ replyRetried: false, replySuppressed: true })
  })

  it('照回声的样子起头、随后出错的一轮:攒着的那段不进事项事件流,工具事件照留', async () => {
    const { runner, opened, handle } = harness()
    const tool: AgentEvent = { kind: 'tool_call', tool: 'Read' }
    const boom: AgentEvent = { kind: 'error', message: 'upstream 500' } as AgentEvent
    const dispatch = vi.fn(handle([tool, { kind: 'text', text: '[System: 在消息发送通道中' }, boom]).dispatch)
    const summary = await runner.run({ chatId: 'c', alias: 'a', providerId: 'openai', handle: { dispatch }, prompt: 'hi', budget: 'turn', startedAt: 100, turn: {} })
    expect(summary.error).toBeTruthy()
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(opened[0]!.events.filter(ev => ev.kind === 'text')).toEqual([])
    expect(opened[0]!.events).toContainEqual(tool)
  })

  it('「NO_REPLY + 注记」写在同一个文字事件里:也先攒着,重答后事项事件流里没有那句注记', async () => {
    const { runner, opened, handle } = harness()
    const answer: AgentEvent = { kind: 'text', text: '记下了。' }
    const dispatch = vi.fn()
      .mockImplementationOnce(handle([{ kind: 'text', text: 'NO_REPLY\n[System: 工具结果返回为空字符串]' }, RESULT]).dispatch)
      .mockImplementationOnce(handle([answer, RESULT]).dispatch)
    const summary = await runner.run({ chatId: 'c', alias: 'a', providerId: 'openai', handle: { dispatch }, prompt: 'hi', budget: 'turn', startedAt: 100, turn: {} })
    expect(summary).toMatchObject({ replyRetried: true, finalText: '记下了。' })
    expect(opened[0]!.events.filter(ev => ev.kind === 'text')).toEqual([answer])
  })

  it('出错的一轮里正常的话照旧进事项事件流', async () => {
    const { runner, opened, handle } = harness()
    const said: AgentEvent = { kind: 'text', text: '查到一半,' }
    const boom: AgentEvent = { kind: 'error', message: 'upstream 500' } as AgentEvent
    const dispatch = vi.fn(handle([said, boom]).dispatch)
    await runner.run({ chatId: 'c', alias: 'a', providerId: 'openai', handle: { dispatch }, prompt: 'hi', budget: 'turn', startedAt: 100, turn: {} })
    expect(opened[0]!.events).toContainEqual(said)
  })

  it('run 开一轮、事件都给它;record 按同一个 turn 标记收同一轮,只收一次', async () => {
    const { runner, opened, recordTurn, handle } = harness()
    const tool: AgentEvent = { kind: 'tool_call', tool: 'Bash' }
    const turn = {}
    const summary = await runner.run({ chatId: 'c', alias: 'a', providerId: 'claude', handle: handle([tool, RESULT]), prompt: 'hi', budget: 'turn', startedAt: 100, turn })
    runner.record({ chatId: 'c', provider: 'claude', alias: 'a', mode: 'solo', startedAt: 100, endedAt: 200, outcome: 'completed', summary, turn })
    expect(opened).toHaveLength(1)
    expect(opened[0]!.events).toEqual([tool, RESULT])
    expect(opened[0]!.ends).toEqual([expect.objectContaining({ mode: 'solo', outcome: 'completed', endedAt: 200, summary: { replyToolCalled: false, toolCalls: ['Bash'], textChunks: 0 } })])
    expect(recordTurn).toHaveBeenCalledTimes(1)
  })
  it('同一个对话同一家同一毫秒开两轮:按各自的 turn 标记对上,不互相覆盖(Codex 评审 P2)', async () => {
    const { runner, opened, handle } = harness()
    const first = {}, second = {}
    const [a, b] = await Promise.all([
      runner.run({ chatId: 'c', alias: 'a', providerId: 'claude', handle: handle([RESULT]), prompt: 'x', budget: 'turn', startedAt: 7, turn: first }),
      runner.run({ chatId: 'c', alias: 'a', providerId: 'claude', handle: handle([RESULT]), prompt: 'y', budget: 'turn', startedAt: 7, turn: second }),
    ])
    runner.record({ chatId: 'c', provider: 'claude', alias: 'a', mode: 'solo', startedAt: 7, endedAt: 8, outcome: 'completed', summary: a, turn: first })
    runner.record({ chatId: 'c', provider: 'claude', alias: 'a', mode: 'solo', startedAt: 7, endedAt: 9, outcome: 'error', summary: b, turn: second })
    expect(opened.map(o => o.ends)).toEqual([[expect.objectContaining({ mode: 'solo', outcome: 'completed', endedAt: 8 })], [expect.objectContaining({ mode: 'solo', outcome: 'error', endedAt: 9 })]])
  })
  it('没走到 run(会话起不来)⇒ record 补开一轮当场收,带上错误', () => {
    const { runner, opened } = harness()
    runner.record({ chatId: 'c', provider: 'codex', alias: 'a', mode: 'solo', startedAt: 5, endedAt: 6, outcome: 'error', summary: undefined, error: 'spawn failed' })
    expect(opened).toMatchObject([{ provider: 'codex', startedAt: 5, events: [], ends: [{ mode: 'solo', outcome: 'error', error: 'spawn failed', endedAt: 6 }] }])
  })
  it('同一时刻几位执行者(/both):各自一轮,各收各的', async () => {
    const { runner, opened, handle } = harness()
    const ta = {}, tb = {}
    const [a, b] = await Promise.all([
      runner.run({ chatId: 'c', alias: 'a', providerId: 'claude', handle: handle([RESULT]), prompt: 'x', budget: 'turn', startedAt: 7, turn: ta }),
      runner.run({ chatId: 'c', alias: 'a', providerId: 'codex', handle: handle([RESULT]), prompt: 'x', budget: 'turn', startedAt: 7, turn: tb }),
    ])
    runner.record({ chatId: 'c', provider: 'codex', alias: 'a', mode: 'parallel', startedAt: 7, endedAt: 8, outcome: 'completed', summary: b, turn: tb })
    runner.record({ chatId: 'c', provider: 'claude', alias: 'a', mode: 'parallel', startedAt: 7, endedAt: 9, outcome: 'timeout', summary: a, turn: ta })
    expect(opened.map(o => [o.provider, o.ends])).toEqual([
      ['claude', [expect.objectContaining({ mode: 'parallel', outcome: 'timeout', endedAt: 9 })]],
      ['codex', [expect.objectContaining({ mode: 'parallel', outcome: 'completed', endedAt: 8 })]],
    ])
  })
  it('记轮的实现抛错不影响回合与 turn_records', async () => {
    const recordTurn = vi.fn()
    const runner = createTurnRunner({ textStrategyFor: () => 'last_segment', deps: { recordTurn, chatTurns: { begin: () => { throw new Error('db gone') }, interruptAll: () => {} } }, nowMs: () => 0 } as unknown as CoordinatorCtx)
    const summary = await runner.run({ chatId: 'c', alias: 'a', providerId: 'claude', handle: { dispatch: () => (async function* () { yield RESULT })() }, prompt: 'x', budget: 'turn', startedAt: 1, turn: {} })
    expect(summary.result?.sessionId).toBe('s')
    runner.record({ chatId: 'c', provider: 'claude', alias: 'a', mode: 'solo', startedAt: 1, endedAt: 2, outcome: 'completed', summary })
    expect(recordTurn).toHaveBeenCalledTimes(1)
  })
})
