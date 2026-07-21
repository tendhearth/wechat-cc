import { describe, expect, it } from 'vitest'
import { makeBroker, type BrokerSeekRow } from './social-broker'

const cheapEval = async () => JSON.stringify({ violation: false, redacted: '找摄影搭子' })
const peerB = { id: 'ccb', name: 'CC-B' } as any

// A scheduler that captures the background coroutine so the test can assert
// what state exists BEFORE it runs, then drive it deterministically.
function deferred() {
  const jobs: Array<() => Promise<void>> = []
  return { schedule: (fn: () => Promise<void>) => { jobs.push(fn) }, run: () => Promise.all(jobs.map(j => j())) }
}

// In-memory social_seek row map so confirmSeek/cancelSeek can read back a row
// proposeRow persisted (or a test seeded). Mirrors the real seekStore contract.
function rowMap() {
  const rows = new Map<string, { status: string; topic: string; redacted_topic: string | null; redacted_city: string | null }>()
  return {
    rows,
    proposeRow: (id: string, r: { topic: string; redactedTopic: string; redactedCity?: string }) => {
      rows.set(id, { status: 'proposed', topic: r.topic, redacted_topic: r.redactedTopic, redacted_city: r.redactedCity ?? null })
    },
    readSeek: (id: string): BrokerSeekRow | null => rows.get(id) ?? null,
    markStatus: (id: string, status: 'foraging' | 'cancelled') => { const row = rows.get(id); if (row) row.status = status },
  }
}

function stubDeps(over: Partial<Parameters<typeof makeBroker>[0]> = {}) {
  const map = rowMap()
  return {
    policy: 'p', cheapEval,
    discover: async () => [peerB],
    send: async () => ({ intent_id: 'x', match: 'yes' as const, blurb: '也爱摄影' }),
    sow: () => {},
    proposeRow: map.proposeRow,
    readSeek: map.readSeek,
    markStatus: map.markStatus,
    recordEcho: () => {},
    finishSeek: () => {},
    ...over,
  }
}

describe('makeBroker.propose — gates + persists, sends nothing', () => {
  it('propose with a passing gate returns the redacted intent and persists it, exposing nothing', async () => {
    let sent = 0, discovered = 0, scheduled = 0
    const proposed: Array<{ id: string; r: any }> = []
    const broker = makeBroker(stubDeps({
      cheapEval: async () => JSON.stringify({ violation: false, redacted: '找搭子' }),
      proposeRow: (id, r) => proposed.push({ id, r }),
      discover: async () => { discovered++; return [peerB] },
      send: async () => { sent++; return { intent_id: 'x', match: 'yes' as const } },
      schedule: () => { scheduled++ },
    }))
    const out = await broker.propose('找搭子')
    expect(out).toMatchObject({ ok: true, redacted: '找搭子' })
    expect((out as any).intent_id).toMatch(/.+/)
    expect(proposed).toHaveLength(1)
    expect(proposed[0]!.r.redactedTopic).toBe('找搭子')
    expect([sent, discovered, scheduled]).toEqual([0, 0, 0])   // propose sends/discovers/schedules NOTHING
  })

  it('propose gate-reject persists nothing', async () => {
    let proposedCount = 0
    const broker = makeBroker(stubDeps({
      cheapEval: async () => JSON.stringify({ violation: true, redacted: '', reasons: ['leak'] }),
      proposeRow: () => { proposedCount++ },
    }))
    const out = await broker.propose('涉密意图')
    expect(out.ok).toBe(false)
    expect((out as any).reason).toMatch(/.+/)
    expect(proposedCount).toBe(0)
  })

  it('propose gates the city too: redacted city rides through', async () => {
    let n = 0
    const proposed: Array<{ id: string; r: any }> = []
    const broker = makeBroker(stubDeps({
      cheapEval: async () => { n++; return JSON.stringify(n === 1 ? { violation: false, redacted: '找搭子' } : { violation: false, redacted: '<CITY>' }) },
      proposeRow: (id, r) => proposed.push({ id, r }),
    }))
    const out = await broker.propose('找搭子', { city: 'Beijing' })
    expect(out).toMatchObject({ ok: true, redacted_city: '<CITY>' })
    expect(proposed[0]!.r.redactedCity).toBe('<CITY>')
  })

  it('propose with a blocked city: city omitted, propose still ok', async () => {
    let n = 0
    const proposed: Array<{ id: string; r: any }> = []
    const broker = makeBroker(stubDeps({
      cheapEval: async () => { n++; return JSON.stringify(n === 1 ? { violation: false, redacted: '找搭子' } : { violation: true, redacted: '', reasons: ['addr'] }) },
      proposeRow: (id, r) => proposed.push({ id, r }),
    }))
    const out = await broker.propose('找搭子', { city: 'Beijing' })
    expect(out.ok).toBe(true)
    expect((out as any).redacted_city).toBeUndefined()
    expect(proposed[0]!.r.redactedCity).toBeUndefined()
  })
})

describe('makeBroker.confirmSeek — WYSIWYG, no re-gate', () => {
  it('confirm forages the STORED redacted string byte-for-byte and never re-gates', async () => {
    let evalCount = 0
    const map = rowMap()
    map.rows.set('i1', { status: 'proposed', topic: '找摄影搭子+电话 138…', redacted_topic: '寻找摄影伙伴【已清理】', redacted_city: null })
    const marked: Array<[string, string]> = []
    let sentCard: any
    const d = deferred()
    const broker = makeBroker(stubDeps({
      cheapEval: async () => { evalCount++; return JSON.stringify({ violation: false, redacted: '不该出现' }) },
      readSeek: map.readSeek,
      markStatus: (id, s) => { marked.push([id, s]); map.markStatus(id, s) },
      send: async (_h: any, card: any) => { sentCard = card; return { intent_id: 'x', match: 'yes' as const } },
      schedule: d.schedule,
    }))
    const evalBefore = evalCount
    const out = broker.confirmSeek('i1')
    expect(out).toEqual({ ok: true, intent_id: 'i1' })
    expect(marked).toEqual([['i1', 'foraging']])
    await d.run()
    expect(sentCard.topic).toBe('寻找摄影伙伴【已清理】')   // the stored redacted string, verbatim
    expect(evalCount).toBe(evalBefore)                       // ZERO cheapEval during confirm/forage — no re-gate
  })

  it('confirm carries the stored redacted city verbatim to card.city', async () => {
    const map = rowMap()
    map.rows.set('i2', { status: 'proposed', topic: '找搭子', redacted_topic: '找搭子【已清理】', redacted_city: '<STORED-CITY>' })
    let sentCard: any
    const d = deferred()
    const broker = makeBroker(stubDeps({
      readSeek: map.readSeek, markStatus: map.markStatus,
      send: async (_h: any, card: any) => { sentCard = card; return { intent_id: 'x', match: 'yes' as const } },
      schedule: d.schedule,
    }))
    broker.confirmSeek('i2')
    await d.run()
    expect(sentCard.city).toBe('<STORED-CITY>')
  })

  it('confirm on a non-proposed / missing row returns not_proposed and does nothing', async () => {
    const map = rowMap()
    map.rows.set('i3', { status: 'foraging', topic: 't', redacted_topic: 'r', redacted_city: null })
    let marked = 0, scheduled = 0
    const broker = makeBroker(stubDeps({
      readSeek: map.readSeek,
      markStatus: () => { marked++ },
      schedule: () => { scheduled++ },
    }))
    expect(broker.confirmSeek('i3')).toEqual({ ok: false, reason: 'not_proposed' })   // already foraging
    expect(broker.confirmSeek('nope')).toEqual({ ok: false, reason: 'not_proposed' }) // unknown
    expect([marked, scheduled]).toEqual([0, 0])
  })
})

describe('makeBroker.cancelSeek', () => {
  it('cancels a proposed row, is idempotent, and reports not_found for an unknown id', async () => {
    const map = rowMap()
    map.rows.set('c1', { status: 'proposed', topic: 't', redacted_topic: 'r', redacted_city: null })
    const marked: Array<[string, string]> = []
    const broker = makeBroker(stubDeps({
      readSeek: map.readSeek,
      markStatus: (id, s) => { marked.push([id, s]); map.markStatus(id, s) },
    }))
    expect(broker.cancelSeek('c1')).toEqual({ ok: true })
    expect(marked).toEqual([['c1', 'cancelled']])
    // Second cancel on the now-cancelled row: idempotent, no throw, no re-write.
    expect(broker.cancelSeek('c1')).toEqual({ ok: true })
    expect(marked).toHaveLength(1)
    expect(broker.cancelSeek('missing')).toEqual({ ok: false, reason: 'not_found' })
  })
})

describe('makeBroker.forage (pre-gated) — invariants, driven via propose+confirmSeek', () => {
  // Seed a proposed row, confirm it, then drive the deferred forage. Because
  // forage is de-gated, these prove the network-leg invariants unchanged.
  function seedConfirm(over: Partial<Parameters<typeof makeBroker>[0]> = {}) {
    const map = rowMap()
    map.rows.set('f1', { status: 'proposed', topic: '找摄影搭子', redacted_topic: '找摄影搭子', redacted_city: null })
    const d = deferred()
    const broker = makeBroker(stubDeps({ readSeek: map.readSeek, markStatus: map.markStatus, schedule: d.schedule, ...over }))
    return { broker, d }
  }

  it('the FIRST echo per seek is flagged first:true, the rest first:false', async () => {
    const flags: boolean[] = []
    const { broker, d } = seedConfirm({
      discover: async () => [peerB, { id: 'ccc', name: 'CC-C' } as any],
      recordEcho: (e) => { flags.push(e.first) },
    })
    broker.confirmSeek('f1'); await d.run()
    expect(flags).toEqual([true, false])
  })

  it('one bad peer does not abort the forage — the good peer still records', async () => {
    const recorded: Array<string | null> = []
    const bad = { id: 'bad', name: 'BAD' } as any
    const { broker, d } = seedConfirm({
      discover: async () => [bad, peerB],
      send: async (hand: any) => { if (hand.id === 'bad') throw new Error('boom'); return { intent_id: 'x', match: 'yes' as const, blurb: 'ok' } },
      recordEcho: (e) => { recorded.push(e.peerAgentId) },
    })
    broker.confirmSeek('f1'); await d.run()
    expect(recorded).toEqual(['ccb'])
  })

  it('a recordEcho store failure never throws out of the forage', async () => {
    const { broker, d } = seedConfirm({ recordEcho: () => { throw new Error('db locked') } })
    broker.confirmSeek('f1')
    await expect(d.run()).resolves.toBeDefined()   // forage swallows the write failure
  })

  it('records degree-2 relay echoes from a response forwarded[] (spec #2)', async () => {
    const recorded: any[] = []
    const { broker, d } = seedConfirm({
      send: async () => ({ intent_id: 'x', match: 'no' as const, forwarded: [{ blurb: '经W的回声', degree: 2, relay_token: 'T' }] }),
      recordEcho: (e: any) => recorded.push(e),
    })
    broker.confirmSeek('f1'); await d.run()
    const relay = recorded.find(r => r.relayToken === 'T')
    expect(relay).toMatchObject({ intentId: 'f1', peerAgentId: null, relayVia: expect.any(String), relayToken: 'T', degree: 2 })
  })
})

describe('makeBroker.seek — deprecated bridge (deleted in Task 7)', () => {
  it('sows a foraging row and forages the REDACTED string (not raw input)', async () => {
    const sown: Array<{ id: string; topic: string }> = []
    let sentCard: any
    const d = deferred()
    const broker = makeBroker(stubDeps({
      cheapEval: async () => JSON.stringify({ violation: false, redacted: '寻找摄影伙伴【已清理】' }),
      sow: (id, topic) => { sown.push({ id, topic }) },
      send: async (_h: any, card: any) => { sentCard = card; return { intent_id: 'x', match: 'yes' as const } },
      schedule: d.schedule,
    }))
    const out = await broker.seek('找摄影搭子+电话')
    expect(sown).toEqual([{ id: out.intent_id, topic: '找摄影搭子+电话' }])   // sow keeps the raw (row re-gated on resume)
    await d.run()
    expect(sentCard.topic).toBe('寻找摄影伙伴【已清理】')
    expect(sentCard.topic).not.toBe('找摄影搭子+电话')
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
})
