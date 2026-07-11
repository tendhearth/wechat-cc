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
    expect(r).toEqual({ batches: 2, recorded: 2 })
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
    expect(r).toEqual({ batches: 0, recorded: 0 })
    expect(call.mock.calls.some(c => c[0] === 'record_facts')).toBe(false)
  })
})
