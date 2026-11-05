import { describe, it, expect } from 'vitest'
import { buildExtractPrompt, parseExtractResponse } from './extract-prompt'

describe('buildExtractPrompt (话题 T1)', () => {
  const base = { newMessages: [{ ts: '2026-06-11T01:00:00Z', direction: 'in' as const, text: '服务器又挂了' }], tagVocabulary: ['产品开发'] }

  it('已有话题带别名和条目索引;规则里写着一条一件事、承诺单独放', () => {
    const p = buildExtractPrompt({ ...base, existingThreads: [{ id: 'thr_1', title: '服务器', facets: ['task'], tags: ['运维'], aliases: ['91', 'mini'], summary: '机队',
      entries: [{ id: 'ent_a', kind: 'commitment', line: '答应换硬盘', due: '2026-06-20' }] }] })
    expect(p).toContain('aliases: [91, mini]')
    expect(p).toContain('· ent_a [承诺] 答应换硬盘(期限 2026-06-20)')
    expect(p).toContain('一条只写一件事')
    expect(p).toContain('承诺单独一条')
    expect(p).toContain('=== 新增对话片段 ===')
    expect(p).toContain('[2026-06-11T01:00:00Z] 主人: 服务器又挂了')
    expect(p).not.toContain('agent 做完的活')
  })

  it('有 agent 结论才出那一段;近期历史单独一段', () => {
    const p = buildExtractPrompt({ ...base, existingThreads: [], contextTail: [{ ts: '2026-06-10T01:00:00Z', direction: 'out', text: '旧话' }],
      workResults: [{ matterId: 'm1', title: '修 DNS', project: 'bx', state: 'done', ask: null, result: '好了', at: '2026-06-11T02:00:00Z' }] })
    expect(p).toContain('=== agent 做完的活(只记结论) ===')
    expect(p).toContain('事 m1(📁 bx · 修 DNS,done)')
    expect(p).toContain('近期历史')
    expect(p.indexOf('旧话')).toBeLessThan(p.indexOf('服务器又挂了'))
  })

  it('长消息截断', () => {
    const p = buildExtractPrompt({ ...base, newMessages: [{ ts: '2026-06-11T01:00:00Z', direction: 'in', text: 'y'.repeat(800) }], existingThreads: [] })
    expect(p).toContain('y'.repeat(500) + '…')
    expect(p).not.toContain('y'.repeat(501))
  })
})

describe('parseExtractResponse', () => {
  it('五种 op;代码围栏和前后废话都能剥掉', () => {
    const r = parseExtractResponse('好的:\n```json\n' + JSON.stringify({ ops: [
      { op: 'create_topic', title: 'bx', summary: 's', facets: ['task'], tags: [], private: false, entries: [{ kind: 'fact', line: 'l' }] },
      { op: 'update_topic', id: 'thr_1', title: '短' },
      { op: 'touch', id: 'thr_1', episode: { from_ts: '2026-06-11T01:00:00Z', to_ts: '2026-06-11T01:00:00Z' } },
      { op: 'add_entry', topic: 'thr_1', kind: 'commitment', line: 'c', due: '2026-06-20' },
      { op: 'update_entry', id: 'ent_1', status: 'done' },
    ] }) + '\n```')
    expect(r!.dropped).toBe(0)
    expect(r!.ops.map(o => o.op)).toEqual(['create_topic', 'update_topic', 'touch', 'add_entry', 'update_entry'])
    expect(r!.ops[0]).toMatchObject({ aliases: [], entries: [{ kind: 'fact', line: 'l' }] })
  })

  it('单条写错只丢那一条;整体不成形 ⇒ null', () => {
    const r = parseExtractResponse(JSON.stringify({ ops: [
      { op: 'touch', id: 'x', episode: { from_ts: '2026-06-11 01:00', to_ts: '2026-06-11T01:00:00Z' } },
      { op: 'add_entry', topic: 'thr_1', kind: 'fact', line: '   ' },
      { op: 'add_entry', topic: 'thr_1', kind: 'commitment', line: 'c', due: '下周' },
      { op: 'add_entry', topic: 'thr_1', kind: 'fact', line: 'ok' },
      { op: 'create' },
    ] }))
    expect(r).toEqual({ ops: [{ op: 'add_entry', topic: 'thr_1', kind: 'fact', line: 'ok' }], dropped: 4 })
    expect(parseExtractResponse('garbage')).toBeNull()
    expect(parseExtractResponse('{"nope":[]}')).toBeNull()
    expect(parseExtractResponse('')).toBeNull()
    expect(parseExtractResponse('{"ops":[]}')).toEqual({ ops: [], dropped: 0 })
  })
})
