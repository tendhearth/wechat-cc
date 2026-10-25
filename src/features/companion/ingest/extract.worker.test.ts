import { describe, it, expect, vi } from 'vitest'
import { runExtraction } from './extract'

function realBatch(id: string): string {
  return JSON.stringify({
    batch_id: id, contact: 'wxid_z', display: '张三',
    messages: [{ msg_key: 'k', sender: '张三', time: 1, text: '还你书' }],
  })
}
const oneFact = '[{"kind":"obligation","predicate":"欠","value":"书"}]'

describe('runExtraction', () => {
  it('drains until extraction_batch reports done, recording each batch', async () => {
    const calls: Array<{ tool: string; input?: unknown }> = []
    const call = vi.fn(async (tool: string, input?: unknown) => {
      calls.push({ tool, input })
      if (tool === 'extraction_batch') {
        const n = calls.filter(c => c.tool === 'extraction_batch').length
        return n <= 2 ? realBatch(`b${n}`) : JSON.stringify({ done: true })
      }
      return JSON.stringify({ recorded: 1 })
    })
    const cheapEval = vi.fn(async () => oneFact)
    const r = await runExtraction({ call, cheapEval, cap: 10 })
    expect(r).toEqual({ batches: 2, recorded: 2, settled: 0 })
    const records = calls.filter(c => c.tool === 'record_facts')
    expect(records.map(c => (c.input as { batch_id: string }).batch_id)).toEqual(['b1', 'b2'])
  })

  it('respects the per-cycle cap', async () => {
    const call = vi.fn(async (tool: string) =>
      tool === 'extraction_batch' ? realBatch('b') : JSON.stringify({ recorded: 0 }))
    const cheapEval = vi.fn(async () => oneFact)
    const r = await runExtraction({ call, cheapEval, cap: 4 })
    expect(r.batches).toBe(4)
    expect(call.mock.calls.filter(c => c[0] === 'extraction_batch')).toHaveLength(4)
  })

  it('advances the watermark (records []) on unusable model output', async () => {
    const call = vi.fn(async (tool: string, _input?: unknown) => {
      if (tool === "extraction_batch") {
        const done = call.mock.calls.filter(c => c[0] === 'extraction_batch').length > 1
        return done ? JSON.stringify({ done: true }) : realBatch('b1')
      }
      return JSON.stringify({ recorded: 0 })
    })
    const cheapEval = vi.fn(async () => '我不能帮你')   // refusal, no array
    const r = await runExtraction({ call, cheapEval, cap: 10 })
    expect(r.recorded).toBe(0)
    const rec = call.mock.calls.find(c => c[0] === 'record_facts')
    expect(rec).toBeTruthy()
    expect((rec![1] as { facts: unknown[] }).facts).toEqual([])   // advanced with empty
  })

  it('does NOT record (preserves watermark) when cheapEval throws', async () => {
    const call = vi.fn(async (tool: string) =>
      tool === 'extraction_batch' ? realBatch('b1') : JSON.stringify({ recorded: 0 }))
    const cheapEval = vi.fn(async () => { throw new Error('model timeout') })
    const r = await runExtraction({ call, cheapEval, cap: 10 })
    expect(r).toEqual({ batches: 0, recorded: 0, settled: 0 })
    expect(call.mock.calls.some(c => c[0] === 'record_facts')).toBe(false)
  })
})

import { buildConflictPrompt, parseSupersedePairs } from './extract'

describe('conflict resolution (temporal validity)', () => {
  const conflictedRecord = JSON.stringify({
    recorded: 1, merged: 0, advanced_to: 1,
    conflicts: [{ id: 22, predicate: '住在', value: '上海', against: [{ id: 11, value: '北京' }] }],
  })

  it('parseSupersedePairs: tolerant parse, drops malformed, [] on garbage', () => {
    expect(parseSupersedePairs('[{"supersede":1,"by":2},{"supersede":"x","by":3},{"by":4}]'))
      .toEqual([{ supersede: 1, by: 2 }])
    expect(parseSupersedePairs('```json\n[{"supersede":1,"by":2}]\n```')).toEqual([{ supersede: 1, by: 2 }])
    expect(parseSupersedePairs('我不能帮你')).toEqual([])
    expect(parseSupersedePairs('{"supersede":1,"by":2}')).toEqual([])
  })

  it('buildConflictPrompt names both facts and demands JSON-only output', () => {
    const p = buildConflictPrompt([{ id: 22, predicate: '住在', value: '上海', against: [{ id: 11, value: '北京' }] }])
    expect(p).toContain('#22')
    expect(p).toContain('#11')
    expect(p).toContain('北京')
    expect(p).toContain('只输出 JSON 数组')
  })

  it('resolves conflicts with one judge call and calls supersede_facts', async () => {
    const calls: Array<{ tool: string; input?: unknown }> = []
    const call = vi.fn(async (tool: string, input?: unknown) => {
      calls.push({ tool, input })
      if (tool === 'extraction_batch') {
        const n = calls.filter(c => c.tool === 'extraction_batch').length
        return n <= 1 ? realBatch('b1') : JSON.stringify({ done: true })
      }
      if (tool === 'record_facts') return conflictedRecord
      return JSON.stringify({ superseded: 1 })
    })
    const cheapEval = vi.fn(async (prompt: string) =>
      prompt.includes('事实库管理器') ? '[{"supersede":11,"by":22}]' : oneFact)
    const r = await runExtraction({ call, cheapEval, cap: 10 })
    expect(r).toEqual({ batches: 1, recorded: 1, settled: 0 })
    const sup = calls.find(c => c.tool === 'supersede_facts')
    expect(sup).toBeTruthy()
    expect(sup!.input).toEqual({ pairs: [{ supersede: 11, by: 22 }] })
  })

  it('judge eval throw → no supersede call, batch still counts, loop continues', async () => {
    const call = vi.fn(async (tool: string) => {
      if (tool === 'extraction_batch') {
        const n = call.mock.calls.filter(c => c[0] === 'extraction_batch').length
        return n <= 1 ? realBatch('b1') : JSON.stringify({ done: true })
      }
      if (tool === 'record_facts') return conflictedRecord
      return JSON.stringify({ superseded: 0 })
    })
    const cheapEval = vi.fn(async (prompt: string) => {
      if (prompt.includes('事实库管理器')) throw new Error('judge down')
      return oneFact
    })
    const r = await runExtraction({ call, cheapEval, cap: 10 })
    expect(r).toEqual({ batches: 1, recorded: 1, settled: 0 })
    expect(call.mock.calls.some(c => c[0] === 'supersede_facts')).toBe(false)
  })

  it('judge returning no pairs → no supersede call', async () => {
    const call = vi.fn(async (tool: string) => {
      if (tool === 'extraction_batch') {
        const n = call.mock.calls.filter(c => c[0] === 'extraction_batch').length
        return n <= 1 ? realBatch('b1') : JSON.stringify({ done: true })
      }
      if (tool === 'record_facts') return conflictedRecord
      return JSON.stringify({ superseded: 0 })
    })
    const cheapEval = vi.fn(async (prompt: string) =>
      prompt.includes('事实库管理器') ? '[]' : oneFact)
    await runExtraction({ call, cheapEval, cap: 10 })
    expect(call.mock.calls.some(c => c[0] === 'supersede_facts')).toBe(false)
  })

  it('no conflicts in record_facts response → no conflict-judge call', async () => {
    const call = vi.fn(async (tool: string) => {
      if (tool === 'extraction_batch') {
        const n = call.mock.calls.filter(c => c[0] === 'extraction_batch').length
        return n <= 1 ? realBatch('b1') : JSON.stringify({ done: true })
      }
      return JSON.stringify({ recorded: 1, conflicts: [] })
    })
    const cheapEval = vi.fn(async () => oneFact)
    await runExtraction({ call, cheapEval, cap: 10 })
    expect(cheapEval).toHaveBeenCalledTimes(1)   // extraction only, no judge
  })
})

import { buildSettlementPrompt, parseResolvedIds } from './extract'

describe('obligation settlement (承诺了结闭环)', () => {
  const obligations = [
    { id: 7, predicate: '还书', value: '答应还他《三体》', time_ref: '2026-08-20' },
    { id: 9, predicate: 'help_vps', value: '帮他配 VPS' },
  ]

  it('parseResolvedIds: numbers only, drops garbage, [] on refusal', () => {
    expect(parseResolvedIds('[7, 9]')).toEqual([7, 9])
    expect(parseResolvedIds('```json\n[7]\n```')).toEqual([7])
    expect(parseResolvedIds('[7, "x", null, 9.0]')).toEqual([7, 9])
    expect(parseResolvedIds('我不能')).toEqual([])
    expect(parseResolvedIds('{"resolved":7}')).toEqual([])
  })

  it('buildSettlementPrompt lists chat + obligations and demands conservative JSON ids', () => {
    const batch = JSON.parse(realBatch('b1'))
    const p = buildSettlementPrompt(batch, obligations)
    expect(p).toContain('还你书')                       // the chat lines
    expect(p).toContain('#7「还书」答应还他《三体》（2026-08-20）')
    expect(p).toContain('#9「help_vps」帮他配 VPS')
    expect(p).toContain('已经了结')
    expect(p).toContain('只输出 JSON 数组')
    expect(p).toContain('不确定就不输出')
  })

  it('settles judge-confirmed ids via settle_obligations', async () => {
    const calls: Array<{ tool: string; input?: unknown }> = []
    const call = vi.fn(async (tool: string, input?: unknown) => {
      calls.push({ tool, input })
      if (tool === 'extraction_batch') {
        const n = calls.filter(c => c.tool === 'extraction_batch').length
        return n <= 1 ? realBatch('b1') : JSON.stringify({ done: true })
      }
      if (tool === 'active_obligations') return JSON.stringify({ obligations })
      if (tool === 'settle_obligations') return JSON.stringify({ settled: 1 })
      return JSON.stringify({ recorded: 1, conflicts: [] })
    })
    const cheapEval = vi.fn(async (prompt: string) =>
      prompt.includes('已经了结') ? '[7]' : oneFact)
    const r = await runExtraction({ call, cheapEval, cap: 10 })
    expect(r).toEqual({ batches: 1, recorded: 1, settled: 1 })
    const settle = calls.find(c => c.tool === 'settle_obligations')
    expect(settle!.input).toEqual({ contact: 'wxid_z', ids: [7] })
  })

  it('no active obligations → no settlement judge call', async () => {
    const call = vi.fn(async (tool: string) => {
      if (tool === 'extraction_batch') {
        const n = call.mock.calls.filter(c => c[0] === 'extraction_batch').length
        return n <= 1 ? realBatch('b1') : JSON.stringify({ done: true })
      }
      if (tool === 'active_obligations') return JSON.stringify({ obligations: [] })
      return JSON.stringify({ recorded: 1, conflicts: [] })
    })
    const cheapEval = vi.fn(async () => oneFact)
    await runExtraction({ call, cheapEval, cap: 10 })
    expect(cheapEval).toHaveBeenCalledTimes(1)   // extraction only
    expect(call.mock.calls.some(c => c[0] === 'settle_obligations')).toBe(false)
  })

  it('settlement judge answering [] → nothing settled', async () => {
    const call = vi.fn(async (tool: string) => {
      if (tool === 'extraction_batch') {
        const n = call.mock.calls.filter(c => c[0] === 'extraction_batch').length
        return n <= 1 ? realBatch('b1') : JSON.stringify({ done: true })
      }
      if (tool === 'active_obligations') return JSON.stringify({ obligations })
      return JSON.stringify({ recorded: 1, conflicts: [] })
    })
    const cheapEval = vi.fn(async (prompt: string) =>
      prompt.includes('已经了结') ? '[]' : oneFact)
    const r = await runExtraction({ call, cheapEval, cap: 10 })
    expect(r.settled).toBe(0)
    expect(call.mock.calls.some(c => c[0] === 'settle_obligations')).toBe(false)
  })

  it('settlement failure is non-fatal — batch still counts (legacy bridge without the tools)', async () => {
    const call = vi.fn(async (tool: string) => {
      if (tool === 'extraction_batch') {
        const n = call.mock.calls.filter(c => c[0] === 'extraction_batch').length
        return n <= 1 ? realBatch('b1') : JSON.stringify({ done: true })
      }
      if (tool === 'active_obligations') throw new Error('unknown tool')
      return JSON.stringify({ recorded: 1, conflicts: [] })
    })
    const cheapEval = vi.fn(async () => oneFact)
    const r = await runExtraction({ call, cheapEval, cap: 10 })
    expect(r).toEqual({ batches: 1, recorded: 1, settled: 0 })
  })
})
