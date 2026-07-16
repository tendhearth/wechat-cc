import { describe, expect, it } from 'vitest'
import { makeBroker } from './social-broker'

const cheapEval = async () => JSON.stringify({ violation: false, redacted: '找摄影搭子' })
const peerB = { id: 'ccb', name: 'CC-B' } as any

// A scheduler that captures the background coroutine so the test can assert
// what state exists BEFORE it runs, then drive it deterministically.
function deferred() {
  const jobs: Array<() => Promise<void>> = []
  return { schedule: (fn: () => Promise<void>) => { jobs.push(fn) }, run: () => Promise.all(jobs.map(j => j())) }
}
function stubDeps(over: Partial<Parameters<typeof makeBroker>[0]> = {}) {
  return {
    policy: 'p', cheapEval,
    discover: async () => [peerB],
    send: async () => ({ intent_id: 'x', match: 'yes' as const, blurb: '也爱摄影' }),
    sow: () => {},
    recordEcho: () => {},
    finishSeek: () => {},
    ...over,
  }
}

describe('makeBroker.seek — non-blocking', () => {
  it('returns { intent_id } after the sync leg, BEFORE any echo is recorded', async () => {
    const recorded: Array<string | null> = []
    const d = deferred()
    const broker = makeBroker(stubDeps({ recordEcho: (e) => { recorded.push(e.peerAgentId) }, schedule: d.schedule }))
    const out = await broker.seek('找摄影搭子')
    expect(out.intent_id).toMatch(/.+/)
    expect(recorded).toEqual([])          // background leg has not run yet
    await d.run()
    expect(recorded).toEqual(['ccb'])     // echo recorded only after foraging
  })

  it('sows a foraging seek row synchronously', async () => {
    const sown: Array<{ id: string; topic: string }> = []
    const broker = makeBroker(stubDeps({ sow: (id, topic) => { sown.push({ id, topic }) }, schedule: () => {} }))
    const out = await broker.seek('找摄影搭子')
    expect(sown).toEqual([{ id: out.intent_id, topic: '找摄影搭子' }])
  })

  it('the FIRST echo per seek is flagged first:true, the rest first:false', async () => {
    const flags: boolean[] = []
    const d = deferred()
    const broker = makeBroker(stubDeps({
      discover: async () => [peerB, { id: 'ccc', name: 'CC-C' } as any],
      recordEcho: (e) => { flags.push(e.first) },
      schedule: d.schedule,
    }))
    await broker.seek('找摄影搭子')
    await d.run()
    expect(flags).toEqual([true, false])
  })

  it('finishSeek marks echoed when ≥1 echo, closed when none', async () => {
    const finishes: Array<[string, string, number]> = []
    const d = deferred()
    const yes = makeBroker(stubDeps({ finishSeek: (id, s, n) => finishes.push([id, s, n]), schedule: d.schedule }))
    await yes.seek('找摄影搭子'); await d.run()
    expect(finishes[0]![1]).toBe('echoed')

    const finishes2: Array<[string, string, number]> = []
    const d2 = deferred()
    const no = makeBroker(stubDeps({ send: async () => ({ intent_id: 'x', match: 'no' as const }), finishSeek: (id, s, n) => finishes2.push([id, s, n]), schedule: d2.schedule }))
    await no.seek('找打篮球的'); await d2.run()
    expect(finishes2[0]![1]).toBe('closed')
  })

  it('one bad peer does not abort the forage — the good peer still records', async () => {
    const recorded: Array<string | null> = []
    const d = deferred()
    const bad = { id: 'bad', name: 'BAD' } as any
    const broker = makeBroker(stubDeps({
      discover: async () => [bad, peerB],
      send: async (hand: any) => { if (hand.id === 'bad') throw new Error('boom'); return { intent_id: 'x', match: 'yes' as const, blurb: 'ok' } },
      recordEcho: (e) => { recorded.push(e.peerAgentId) },
      schedule: d.schedule,
    }))
    await broker.seek('找摄影搭子'); await d.run()
    expect(recorded).toEqual(['ccb'])
  })

  it('a recordEcho store failure never throws out of the forage', async () => {
    const d = deferred()
    const broker = makeBroker(stubDeps({ recordEcho: () => { throw new Error('db locked') }, finishSeek: () => {}, schedule: d.schedule }))
    await broker.seek('找摄影搭子')
    await expect(d.run()).resolves.toBeDefined()   // forage swallows the write failure
  })

  it('gate blocks the intent topic → nothing sown, nothing sent, no forage scheduled', async () => {
    let sent = 0, sown = 0, scheduled = 0
    const broker = makeBroker(stubDeps({
      cheapEval: async () => JSON.stringify({ violation: true, redacted: '', reasons: ['leak'] }),
      send: async () => { sent++; return { intent_id: 'x', match: 'yes' as const } },
      sow: () => { sown++ },
      schedule: () => { scheduled++ },
    }))
    const out = await broker.seek('涉密意图')
    expect(out.intent_id).toMatch(/.+/)
    expect([sent, sown, scheduled]).toEqual([0, 0, 0])
  })

  it('redacted topic is what actually gets sent (not raw input)', async () => {
    let sentCard: any
    const d = deferred()
    const broker = makeBroker(stubDeps({
      cheapEval: async () => JSON.stringify({ violation: false, redacted: '寻找摄影伙伴【已清理】' }),
      send: async (_h: any, card: any) => { sentCard = card; return { intent_id: 'x', match: 'yes' as const } },
      schedule: d.schedule,
    }))
    await broker.seek('找摄影搭子+电话'); await d.run()
    expect(sentCard.topic).toBe('寻找摄影伙伴【已清理】')
    expect(sentCard.topic).not.toBe('找摄影搭子+电话')
  })

  it('city gated through: forage sends the redacted city', async () => {
    let sentCard: any, n = 0
    const d = deferred()
    const broker = makeBroker(stubDeps({
      cheapEval: async () => { n++; return JSON.stringify(n === 1 ? { violation: false, redacted: '找摄影搭子' } : { violation: false, redacted: '<REDACTED-CITY>' }) },
      send: async (_h: any, card: any) => { sentCard = card; return { intent_id: 'x', match: 'yes' as const } },
      schedule: d.schedule,
    }))
    await broker.seek('找摄影搭子', { city: 'Beijing' }); await d.run()
    expect(sentCard.city).toBe('<REDACTED-CITY>')
  })

  it('city blocked by gate: omit from card, forage still proceeds', async () => {
    let sentCard: any, n = 0
    const d = deferred()
    const broker = makeBroker(stubDeps({
      // Two topic gates happen on the seek→forage path (seek's abort-early
      // check, then forage's own authoritative re-gate — see the
      // "deliberate, cheap double-gate" note in social-broker.ts). Only the
      // 3rd call is the city gate, which is the one we want to block.
      cheapEval: async () => { n++; return JSON.stringify(n <= 2 ? { violation: false, redacted: '找摄影搭子' } : { violation: true, redacted: '', reasons: ['leak'] }) },
      send: async (_h: any, card: any) => { sentCard = card; return { intent_id: 'x', match: 'yes' as const } },
      schedule: d.schedule,
    }))
    await broker.seek('找摄影搭子', { city: 'Beijing' }); await d.run()
    expect(sentCard.city).toBeUndefined()
  })

  it('records degree-2 relay echoes from a response forwarded[] (spec #2)', async () => {
    const recorded: any[] = []
    const d = deferred()
    const broker = makeBroker(stubDeps({
      send: async () => ({ intent_id: 'x', match: 'no' as const, forwarded: [{ blurb: '经W的回声', degree: 2, relay_token: 'T' }] }),
      recordEcho: (e: any) => recorded.push(e),
      schedule: d.schedule,
    }))
    const out = await broker.seek('找摄影搭子')
    await d.run()
    const relay = recorded.find(r => r.relayToken === 'T')
    expect(relay).toMatchObject({ intentId: out.intent_id, peerAgentId: null, relayVia: expect.any(String), relayToken: 'T', degree: 2 })
  })
})
