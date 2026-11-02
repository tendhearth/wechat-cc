import { describe, expect, it, vi } from 'vitest'
import { createTurnRunner } from './runner'
import type { CoordinatorCtx } from './ctx'
import type { AgentEvent } from '../../ports/agent-provider'
import type { ChatTurnHandle, ChatTurnLog } from '../../ports/chat-turns'

/** runner 把对话的一轮记进这件对话(M3a):run 开、record 收,两边按 startedAt 对上;没走到 run 的也记一轮。 */
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
  it('run 开一轮、事件都给它;record 按 startedAt 收同一轮,只收一次', async () => {
    const { runner, opened, recordTurn, handle } = harness()
    const tool: AgentEvent = { kind: 'tool_call', tool: 'Bash' }
    const summary = await runner.run({ chatId: 'c', alias: 'a', providerId: 'claude', handle: handle([tool, RESULT]), prompt: 'hi', budget: 'turn', startedAt: 100 })
    runner.record({ chatId: 'c', provider: 'claude', alias: 'a', mode: 'solo', startedAt: 100, endedAt: 200, outcome: 'completed', summary })
    expect(opened).toHaveLength(1)
    expect(opened[0]!.events).toEqual([tool, RESULT])
    expect(opened[0]!.ends).toEqual([{ mode: 'solo', outcome: 'completed', endedAt: 200 }])
    expect(recordTurn).toHaveBeenCalledTimes(1)
  })
  it('没走到 run(会话起不来)⇒ record 补开一轮当场收,带上错误', () => {
    const { runner, opened } = harness()
    runner.record({ chatId: 'c', provider: 'codex', alias: 'a', mode: 'solo', startedAt: 5, endedAt: 6, outcome: 'error', summary: undefined, error: 'spawn failed' })
    expect(opened).toMatchObject([{ provider: 'codex', startedAt: 5, events: [], ends: [{ mode: 'solo', outcome: 'error', error: 'spawn failed', endedAt: 6 }] }])
  })
  it('同一时刻几位执行者(/both):各自一轮,各收各的', async () => {
    const { runner, opened, handle } = harness()
    const [a, b] = await Promise.all([
      runner.run({ chatId: 'c', alias: 'a', providerId: 'claude', handle: handle([RESULT]), prompt: 'x', budget: 'turn', startedAt: 7 }),
      runner.run({ chatId: 'c', alias: 'a', providerId: 'codex', handle: handle([RESULT]), prompt: 'x', budget: 'turn', startedAt: 7 }),
    ])
    runner.record({ chatId: 'c', provider: 'codex', alias: 'a', mode: 'parallel', startedAt: 7, endedAt: 8, outcome: 'completed', summary: b })
    runner.record({ chatId: 'c', provider: 'claude', alias: 'a', mode: 'parallel', startedAt: 7, endedAt: 9, outcome: 'timeout', summary: a })
    expect(opened.map(o => [o.provider, o.ends])).toEqual([
      ['claude', [{ mode: 'parallel', outcome: 'timeout', endedAt: 9 }]],
      ['codex', [{ mode: 'parallel', outcome: 'completed', endedAt: 8 }]],
    ])
  })
  it('记轮的实现抛错不影响回合与 turn_records', async () => {
    const recordTurn = vi.fn()
    const runner = createTurnRunner({ deps: { recordTurn, chatTurns: { begin: () => { throw new Error('db gone') }, interruptAll: () => {} } }, nowMs: () => 0 } as unknown as CoordinatorCtx)
    const summary = await runner.run({ chatId: 'c', alias: 'a', providerId: 'claude', handle: { dispatch: () => (async function* () { yield RESULT })() }, prompt: 'x', budget: 'turn', startedAt: 1 })
    expect(summary.result?.sessionId).toBe('s')
    runner.record({ chatId: 'c', provider: 'claude', alias: 'a', mode: 'solo', startedAt: 1, endedAt: 2, outcome: 'completed', summary })
    expect(recordTurn).toHaveBeenCalledTimes(1)
  })
})
