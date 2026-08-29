import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runIngestCycle, maxDecryptedMtime, ingestHasTool, type CycleDeps } from './cycle'

const DONE = JSON.stringify({ done: true })
const BATCH = JSON.stringify({
  batch_id: 'b1', contact: 'c', display: 'd',
  messages: [{ msg_key: 'k', sender: 'd', time: 1, text: 'hi' }],
})

function deps(over: Partial<CycleDeps> & { tools: string[] }): CycleDeps {
  const tools = new Set(over.tools)
  return {
    bridge: over.bridge ?? { call: vi.fn(async () => DONE) },
    hasTool: (t) => tools.has(t),
    cheapEval: over.cheapEval ?? (async () => '[]'),
    sourceMaxMtime: over.sourceMaxMtime ?? (() => 100),
    lastSourceMtime: over.lastSourceMtime ?? 0,
    cap: over.cap ?? 4,
    log: over.log,
  }
}

const ALL = ['overview', 'rebuild', 'index_update', 'voice_backfill', 'extraction_batch']

describe('runIngestCycle', () => {
  it('source advanced ⇒ pokes wxvault, runs all builders, then extracts', async () => {
    const seen: string[] = []
    const bridge = { call: vi.fn(async (t: string) => { seen.push(t); return t === 'extraction_batch' ? DONE : '{}' }) }
    const r = await runIngestCycle(deps({ tools: ALL, bridge, sourceMaxMtime: () => 200, lastSourceMtime: 100 }))
    expect(seen[0]).toBe('overview')
    expect(seen).toContain('rebuild')
    expect(seen).toContain('index_update')
    expect(seen).toContain('voice_backfill')
    expect(r).toMatchObject({ decrypted: true, rebuilt: true, indexed: true, transcribed: true, newSourceMtime: 200 })
  })

  it('source unchanged ⇒ pokes + extracts but runs NO builders', async () => {
    const seen: string[] = []
    const bridge = { call: vi.fn(async (t: string) => { seen.push(t); return t === 'extraction_batch' ? DONE : '{}' }) }
    await runIngestCycle(deps({ tools: ALL, bridge, sourceMaxMtime: () => 100, lastSourceMtime: 100 }))
    expect(seen).toContain('overview')
    expect(seen).not.toContain('rebuild')
    expect(seen).not.toContain('index_update')
    expect(seen).not.toContain('voice_backfill')
  })

  it('skips a builder whose tool is absent, proceeds with the rest', async () => {
    const seen: string[] = []
    const bridge = { call: vi.fn(async (t: string) => { seen.push(t); return t === 'extraction_batch' ? DONE : '{}' }) }
    // no 'rebuild' tool
    const r = await runIngestCycle(deps({ tools: ['overview', 'index_update', 'extraction_batch'], bridge, sourceMaxMtime: () => 200, lastSourceMtime: 100 }))
    expect(seen).not.toContain('rebuild')
    expect(seen).toContain('index_update')
    expect(r.rebuilt).toBe(false)
    expect(r.indexed).toBe(true)
  })

  it('a builder throwing does not abort the cycle (extraction still runs)', async () => {
    let batchCalls = 0
    const bridge = {
      call: vi.fn(async (t: string) => {
        if (t === 'rebuild') throw new Error('boom')
        if (t === 'extraction_batch') { batchCalls++; return batchCalls === 1 ? BATCH : DONE }
        return '{}'
      }),
    }
    const r = await runIngestCycle(deps({ tools: ALL, bridge, cheapEval: async () => '[{"kind":"entity","predicate":"是","value":"x"}]', sourceMaxMtime: () => 200, lastSourceMtime: 100 }))
    expect(r.rebuilt).toBe(false)     // failed
    expect(r.batches).toBe(1)         // extraction still ran
    expect(r.recorded).toBe(1)
  })

  it('runs extraction even when no builder tools exist', async () => {
    const bridge = { call: vi.fn(async () => DONE) }
    const r = await runIngestCycle(deps({ tools: ['extraction_batch'], bridge }))
    expect(r.decrypted).toBe(false)   // no overview tool
    expect(r.batches).toBe(0)         // immediately done
  })

  it('does NOT touch extraction_batch when it is gated off (simulates no cheapEval)', async () => {
    const seen: string[] = []
    const bridge = { call: vi.fn(async (t: string) => { seen.push(t); return '{}' }) }
    // ingestHasTool(..., canExtract=false) hides extraction_batch → same as it being absent here
    const r = await runIngestCycle(deps({ tools: ['overview'], bridge, sourceMaxMtime: () => 1, lastSourceMtime: 1 }))
    expect(seen).not.toContain('extraction_batch')   // never pulled a window
    expect(r.batches).toBe(0)
  })
})

describe('builder cooldown (repeat-timeout damper)', () => {
  it('after 3 consecutive failures a builder is skipped until the cooldown lapses', async () => {
    const { BUILDER_COOLDOWN_MS } = await import('./cycle')
    const health = { fails: new Map() }
    let t = 1_000_000
    const mk = (mtime: number) => {
      const seen: string[] = []
      const bridge = { call: vi.fn(async (tool: string) => {
        seen.push(tool)
        if (tool === 'voice_backfill') throw new Error('MCP error -32001: Request timed out')
        return tool === 'extraction_batch' ? DONE : '{}'
      }) }
      return { seen, d: deps({ tools: ALL, bridge, sourceMaxMtime: () => mtime, lastSourceMtime: mtime - 1 }) }
    }
    // three failing cycles — still attempted each time
    for (let i = 0; i < 3; i++) {
      const { seen, d } = mk(100 + i)
      await runIngestCycle({ ...d, builderHealth: health, now: () => t })
      expect(seen).toContain('voice_backfill')
    }
    // 4th cycle: cooling down — not attempted
    const c4 = mk(200)
    const r4 = await runIngestCycle({ ...c4.d, builderHealth: health, now: () => t })
    expect(c4.seen).not.toContain('voice_backfill')
    expect(r4.transcribed).toBe(false)
    // cooldown lapsed — attempted again
    t += BUILDER_COOLDOWN_MS + 1
    const c5 = mk(300)
    await runIngestCycle({ ...c5.d, builderHealth: health, now: () => t })
    expect(c5.seen).toContain('voice_backfill')
  })

  it('one success wipes the failure streak', async () => {
    const health = { fails: new Map() }
    let fail = true
    const mkAlt = (mtime: number) => {
      const seen: string[] = []
      const bridge = { call: vi.fn(async (tool: string) => {
        seen.push(tool)
        if (tool === 'voice_backfill' && fail) throw new Error('timeout')
        return tool === 'extraction_batch' ? DONE : '{}'
      }) }
      return { seen, d: deps({ tools: ALL, bridge, sourceMaxMtime: () => mtime, lastSourceMtime: mtime - 1 }) }
    }
    await runIngestCycle({ ...mkAlt(100).d, builderHealth: health, now: () => 1 })  // fail 1
    await runIngestCycle({ ...mkAlt(101).d, builderHealth: health, now: () => 1 })  // fail 2
    fail = false
    await runIngestCycle({ ...mkAlt(102).d, builderHealth: health, now: () => 1 })  // success — streak reset
    fail = true
    // two more failures ≠ 3 consecutive → still attempted on the next cycle
    await runIngestCycle({ ...mkAlt(103).d, builderHealth: health, now: () => 1 })
    await runIngestCycle({ ...mkAlt(104).d, builderHealth: health, now: () => 1 })
    const last = mkAlt(105)
    await runIngestCycle({ ...last.d, builderHealth: health, now: () => 1 })
    expect(last.seen).toContain('voice_backfill')
  })
})

describe('runIngestCycle — factsApi (in-proc extraction)', () => {
  it('with factsApi present, extraction runs through it — bridge.call NOT called for extraction_batch, even when hasTool is false', async () => {
    const factsApi = {
      nextBatch: vi.fn(() => ({ done: true })),
      record: vi.fn(),
      contactFacts: vi.fn(() => ({ by_kind: {} })),
      findFacts: vi.fn(),
      setFactStatus: vi.fn(),
      extractionStatus: vi.fn(),
      supersede: vi.fn(() => ({ superseded: 0 })),
      conflictedGroups: vi.fn(() => []),
      obligationHeavyContacts: vi.fn(() => []),
      mergeObligations: vi.fn(() => ({ merged: 0 })),
      settleObligations: vi.fn(() => ({ settled: 0 })),
      recentMessages: vi.fn(() => []),
      judgeFingerprint: vi.fn(() => null),
      setJudgeFingerprint: vi.fn(),
    }
    const bridge = { call: vi.fn(async (_t: string, _i?: unknown) => '{}') }
    const d = deps({ tools: [], bridge })   // no tools at all — extraction_batch absent
    const r = await runIngestCycle({ ...d, factsApi })
    expect(factsApi.nextBatch).toHaveBeenCalledWith(null, 40)
    expect(bridge.call.mock.calls.some((c) => c[0] === 'extraction_batch')).toBe(false)
    expect(r.batches).toBe(0)   // immediately done
  })

  it('with factsApi present and a real batch, record_facts goes through factsApi.record, not the bridge', async () => {
    let calls = 0
    const factsApi = {
      nextBatch: vi.fn(() => {
        calls++
        return calls === 1
          ? { batch_id: 'b1', contact: 'c', display: 'd', messages: [{ msg_key: 'k', sender: 'd', time: 1, text: 'hi' }] }
          : { done: true }
      }),
      record: vi.fn(() => ({ recorded: 1, merged: 0, advanced_to: 1 })),
      contactFacts: vi.fn(() => ({ by_kind: {} })),
      findFacts: vi.fn(),
      setFactStatus: vi.fn(),
      extractionStatus: vi.fn(),
      supersede: vi.fn(() => ({ superseded: 0 })),
      conflictedGroups: vi.fn(() => []),
      obligationHeavyContacts: vi.fn(() => []),
      mergeObligations: vi.fn(() => ({ merged: 0 })),
      settleObligations: vi.fn(() => ({ settled: 0 })),
      recentMessages: vi.fn(() => []),
      judgeFingerprint: vi.fn(() => null),
      setJudgeFingerprint: vi.fn(),
    }
    const bridge = { call: vi.fn(async (_t: string, _i?: unknown) => '{}') }
    const d = deps({ tools: [], bridge, cheapEval: async () => '[{"kind":"entity","predicate":"是","value":"x"}]' })
    const r = await runIngestCycle({ ...d, factsApi })
    expect(factsApi.record).toHaveBeenCalledWith('b1', [{ kind: 'entity', predicate: '是', value: 'x' }], expect.any(Number))
    expect(bridge.call.mock.calls.some((c) => c[0] === 'record_facts')).toBe(false)
    expect(r.batches).toBe(1)
    expect(r.recorded).toBe(1)
  })

  it('without factsApi, the old bridge path is used and still gates on hasTool', async () => {
    const seen: string[] = []
    const bridge = { call: vi.fn(async (t: string) => { seen.push(t); return t === 'extraction_batch' ? DONE : '{}' }) }
    const r = await runIngestCycle(deps({ tools: ['extraction_batch'], bridge }))
    expect(seen).toContain('extraction_batch')
    expect(r.batches).toBe(0)
  })

  it('without factsApi and extraction_batch absent from hasTool, extraction is skipped entirely', async () => {
    const seen: string[] = []
    const bridge = { call: vi.fn(async (t: string) => { seen.push(t); return '{}' }) }
    const r = await runIngestCycle(deps({ tools: [], bridge }))
    expect(seen).not.toContain('extraction_batch')
    expect(r.batches).toBe(0)
  })
})

describe('ingestHasTool', () => {
  it('hides extraction_batch when canExtract is false, but not other tools', () => {
    const h = ingestHasTool(['overview', 'rebuild', 'extraction_batch'], false)
    expect(h('extraction_batch')).toBe(false)
    expect(h('overview')).toBe(true)
    expect(h('rebuild')).toBe(true)
  })
  it('exposes extraction_batch when canExtract is true and the tool is present', () => {
    expect(ingestHasTool(['extraction_batch'], true)('extraction_batch')).toBe(true)
    expect(ingestHasTool([], true)('extraction_batch')).toBe(false)   // absent tool still false
  })
})

describe('maxDecryptedMtime', () => {
  it('returns 0 when the decrypted dir is absent', () => {
    const base = mkdtempSync(join(tmpdir(), 'ingest-mtime-'))
    expect(maxDecryptedMtime(base)).toBe(0)
  })
  it('returns the largest .sqlite mtime, ignoring non-sqlite', () => {
    const base = mkdtempSync(join(tmpdir(), 'ingest-mtime-'))
    const dir = join(base, 'plugin-data', 'wxvault', 'out', 'decrypted')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'message_0.sqlite'), 'x')
    writeFileSync(join(dir, 'message_1.sqlite'), 'y')
    writeFileSync(join(dir, 'notes.txt'), 'z')
    utimesSync(join(dir, 'message_0.sqlite'), new Date(1000), new Date(1000))
    utimesSync(join(dir, 'message_1.sqlite'), new Date(5000), new Date(5000))
    utimesSync(join(dir, 'notes.txt'), new Date(9000), new Date(9000))   // ignored (not .sqlite)
    expect(maxDecryptedMtime(base)).toBe(5000)   // new Date(5000) = 5000ms epoch → mtimeMs 5000
  })
})
