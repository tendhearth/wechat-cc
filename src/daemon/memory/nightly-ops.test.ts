import { describe, it, expect } from 'vitest'
import { parseOps, applyNightly, daysBetween, type NightlyOps } from './nightly-ops'
import { emptyDoc, type MemoryDoc } from './curated-doc'

function doc(): MemoryDoc {
  const d = emptyDoc()
  d.sections['关于你'] = [{ id: 'a001', text: '做 wechat-cc', seen: '2026-09-01' }]
  d.sections['偏好'] = [{ id: 'b001', text: '先打磨再上线', seen: '2026-09-01' }, { id: 'b002', text: '回复直接', seen: '2026-09-01' }]
  d.sections['承诺'] = [{ id: 'c001', text: '给 X 回话(期限 2026-09-10)', seen: '2026-09-05' }]
  d.sections['近况'] = [{ id: 'd001', text: '在赶发版', seen: '2026-09-05' }, { id: 'd002', text: '最近睡得晚', seen: '2026-09-24' }]
  return d
}
const none: NightlyOps = { add: [], update: [], confirm: [], remove: [] }
let n = 0
const opts = { today: '2026-09-25', newId: () => `e${String(n++).padStart(3, '0')}` }

describe('parseOps', () => {
  it('accepts a fenced JSON object with all four keys', () => {
    expect(parseOps('```json\n{"add":[{"section":"承诺","text":"周五回话"}],"update":[],"confirm":["a001"],"remove":[]}\n```'))
      .toEqual({ add: [{ section: '承诺', text: '周五回话' }], update: [], confirm: ['a001'], remove: [] })
  })
  it('rejects missing keys, unknown sections and non-JSON', () => {
    expect(parseOps('{"add":[],"update":[],"confirm":[]}')).toBeNull()
    expect(parseOps('{"add":[{"section":"杂项","text":"x"}],"update":[],"confirm":[],"remove":[]}')).toBeNull()
    expect(parseOps('我觉得没什么要改的')).toBeNull()
  })
})

describe('applyNightly', () => {
  it('applies confirm/update/remove/add and records what happened', () => {
    const r = applyNightly(doc(), {
      add: [{ section: '承诺', text: '周五前给 Y 回话(期限 2026-09-26)' }],
      update: [{ id: 'b001', text: '先上线再优化', reversal: true }],
      confirm: ['a001'],
      remove: [{ id: 'b002', reason: '主人说不对' }],
    }, opts)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.doc.sections['偏好']).toEqual([{ id: 'b001', text: '先上线再优化', seen: '2026-09-25' }])
    expect(r.doc.sections['关于你'][0]!.seen).toBe('2026-09-25')
    expect(r.applied.map(a => a.kind)).toEqual(['update', 'remove', 'add', 'expire', 'expire'])
    expect(r.applied[0]).toMatchObject({ kind: 'update', before: '先打磨再上线', reversal: true, section: '偏好' })
  })
  it('expires commitments >7 days past due and 近况 unconfirmed >14 days', () => {
    const r = applyNightly(doc(), none, opts)
    expect(r.ok && r.applied).toEqual([
      { kind: 'expire', id: 'c001', section: '承诺', text: '给 X 回话(期限 2026-09-10)', reason: 'commitment_past_due' },
      { kind: 'expire', id: 'd001', section: '近况', text: '在赶发版', reason: 'recent_stale' },
    ])
  })
  it('rejects unknown ids, over-long text and mass removal without touching the input', () => {
    const d = doc()
    expect(applyNightly(d, { ...none, confirm: ['zzzz'] }, opts)).toEqual({ ok: false, reason: 'unknown_id:zzzz' })
    expect(applyNightly(d, { ...none, add: [{ section: '偏好', text: 'x'.repeat(201) }] }, opts)).toEqual({ ok: false, reason: 'bad_text' })
    expect(applyNightly(d, { ...none, remove: ['a001', 'b001', 'b002'].map(id => ({ id, reason: 'x' })) }, opts))
      .toEqual({ ok: false, reason: 'too_many_removals' })
    expect(d.sections['偏好'][0]!.text).toBe('先打磨再上线')
  })
  it('fades the oldest 近况 to fit the cap, then gives up', () => {
    const d = emptyDoc()
    d.sections['近况'] = [{ id: 'r001', text: 'x'.repeat(200), seen: '2026-09-20' }, { id: 'r002', text: 'y'.repeat(200), seen: '2026-09-24' }]
    for (let i = 0; i < 14; i++) d.sections['关于你'].push({ id: `f${String(i).padStart(3, '0')}`, text: 'z'.repeat(190), seen: '2026-09-24' })
    const r = applyNightly(d, none, opts)   // 14×190 + 400 = 3060 > 3000
    expect(r.ok && r.applied).toEqual([{ kind: 'expire', id: 'r001', section: '近况', text: 'x'.repeat(200), reason: 'over_cap' }])
    // 再加 400 字:两条近况全淡出后仍是 14×190 + 400 = 3060 > 3000
    d.sections['关于你'].push({ id: 'f998', text: 'v'.repeat(200), seen: '2026-09-24' }, { id: 'f999', text: 'w'.repeat(200), seen: '2026-09-24' })
    expect(applyNightly(d, none, opts)).toEqual({ ok: false, reason: 'over_cap' })
  })
  it('counts days between local dates', () => {
    expect(daysBetween('2026-09-10', '2026-09-25')).toBe(15)
  })
})
