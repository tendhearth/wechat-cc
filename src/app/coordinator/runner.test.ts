import { describe, expect, it, vi } from 'vitest'
import { createTurnRunner } from './runner'
import type { CoordinatorCtx } from './ctx'
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
  const runner = createTurnRunner({ deps: { chatTurns, recordTurn }, nowMs: () => 0 } as unknown as CoordinatorCtx)
  const handle = (events: AgentEvent[]) => ({ dispatch: () => (async function* () { for (const e of events) yield e })() })
  return { runner, opened, recordTurn, handle }
}
const RESULT: AgentEvent = { kind: 'result', sessionId: 's', numTurns: 1, durationMs: 1 }

describe('runner · 对话的轮(M3a)', () => {
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
    const runner = createTurnRunner({ deps: { recordTurn, chatTurns: { begin: () => { throw new Error('db gone') }, interruptAll: () => {} } }, nowMs: () => 0 } as unknown as CoordinatorCtx)
    const summary = await runner.run({ chatId: 'c', alias: 'a', providerId: 'claude', handle: { dispatch: () => (async function* () { yield RESULT })() }, prompt: 'x', budget: 'turn', startedAt: 1, turn: {} })
    expect(summary.result?.sessionId).toBe('s')
    runner.record({ chatId: 'c', provider: 'claude', alias: 'a', mode: 'solo', startedAt: 1, endedAt: 2, outcome: 'completed', summary })
    expect(recordTurn).toHaveBeenCalledTimes(1)
  })
})
