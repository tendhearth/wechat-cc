import { describe, it, expect, vi } from 'vitest'
import { makeAsyncResponder } from './social-async-responder'
import type { IntentEvent } from './a2a-server'

const card = (over: Record<string, unknown> = {}) => ({ intent_id: 'i1', kind: 'seek' as const, topic: '找修相机师傅', hop: 1, expires_at: new Date(Date.now() + 600000).toISOString(), ...over })
const ev = (over: Record<string, unknown> = {}): IntentEvent => ({ agent: { id: 'cc-s' } as any, card: card(over) as any })

function make(over: Record<string, any> = {}) {
  const tasks: Array<() => Promise<void>> = []
  const deps = {
    answerLocally: vi.fn(async () => ({ intent_id: 'i1', match: 'yes' as const, blurb: '我认识一位' })),
    postEcho: vi.fn(async () => true),
    forwardTargets: vi.fn(() => [{ id: 'cc-q' }]),
    forwardSend: vi.fn(async () => true),
    markSeen: vi.fn(), hasSeen: vi.fn(() => false),
    schedule: (fn: () => Promise<void>) => { tasks.push(fn) },
    ...over,
  }
  const onIntent = makeAsyncResponder(deps)
  const drain = async () => { for (const t of tasks.splice(0)) await t() }
  return { onIntent, drain, deps }
}

describe('makeAsyncResponder', () => {
  it('fast-ack:判官慢也立刻返回 {match:no, async:true};markSeen 带 origin 在返回前完成', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const { onIntent, deps } = make({ answerLocally: vi.fn(async () => { await gate; return { intent_id: 'i1', match: 'yes' as const, blurb: 'x' } }), schedule: undefined })
    const r = await onIntent(ev())                                   // schedule 缺省=fire-and-forget,判官挂着也要立刻回
    expect(r).toEqual({ intent_id: 'i1', match: 'no', async: true })
    expect(deps.markSeen).toHaveBeenCalledWith('i1', expect.any(String), 'cc-s')
    release()
  })

  it('后台:判官 yes → postEcho 给发送者,degree=card.hop;no → 不投', async () => {
    const { onIntent, drain, deps } = make()
    await onIntent(ev({ hop: 2 }))
    await drain()
    expect(deps.postEcho).toHaveBeenCalledWith('cc-s', { intent_id: 'i1', echo: { blurb: '我认识一位', degree: 2 } })
    const noMatch = make({ answerLocally: vi.fn(async () => ({ intent_id: 'i1', match: 'no' as const })) })
    await noMatch.onIntent(ev()); await noMatch.drain()
    expect(noMatch.deps.postEcho).not.toHaveBeenCalled()
  })

  it('转发:未见过且 hop<cap 且预算内 → hop+1 fan-out 排除发送者;seen/hop 顶格/超预算 → 不转', async () => {
    const { onIntent, drain, deps } = make()
    await onIntent(ev()); await drain()
    expect(deps.forwardTargets).toHaveBeenCalledWith('cc-s')
    expect(deps.forwardSend).toHaveBeenCalledWith({ id: 'cc-q' }, expect.objectContaining({ hop: 2 }))
    for (const bad of [{ hasSeen: vi.fn(() => true) }, {}, { withinBudget: vi.fn(() => false) }]) {
      const m = make(bad)
      await m.onIntent(ev('hasSeen' in bad || 'withinBudget' in bad ? {} : { hop: 2 })); await m.drain()
      expect(m.deps.forwardSend).not.toHaveBeenCalled()
    }
  })

  it('后台任何一步 throw 都不冒泡(fail-closed):postEcho 崩、forwardSend 崩、判官崩', async () => {
    for (const over of [
      { postEcho: vi.fn(async () => { throw new Error('net') }) },
      { forwardSend: vi.fn(async () => { throw new Error('net') }) },
      { answerLocally: vi.fn(async () => { throw new Error('judge') }) },
    ]) {
      const m = make(over)
      await m.onIntent(ev())
      await expect(m.drain()).resolves.toBeUndefined()
    }
  })
})
