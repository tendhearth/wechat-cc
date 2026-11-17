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

  it('新消息完整送出，不能截断后仍宣告整条已记账', () => {
    const p = buildExtractPrompt({ ...base, newMessages: [{ ts: '2026-06-11T01:00:00Z', direction: 'in', text: 'y'.repeat(800) }], existingThreads: [] })
    expect(p).toContain('y'.repeat(800))
    expect(p).not.toContain('y'.repeat(800) + '…')
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

// 原有用例搬到新的操作形状上(T1:create → create_topic、update → update_topic;单条不合法只丢那一条,不再整批作废)
describe('parseExtractResponse · 原有用例', () => {
  const ep = '"episode":{"from_ts":"2026-06-11T00:00:00Z","to_ts":"2026-06-11T00:01:00Z"}'
  it('rejects malformed responses with null (never throws)', () => {
    expect(parseExtractResponse('not json at all')).toBeNull()
    expect(parseExtractResponse('{"ops": "nope"}')).toBeNull()
    expect(parseExtractResponse('{"ops":[')).toBeNull()
  })
  it('create with empty facets array → null (schema enforces min(1))', () => {
    expect(parseExtractResponse(`{"ops":[{"op":"create_topic","title":"无 facet","summary":"s","facets":[],"tags":[],"private":false,${ep}}]}`)).toEqual({ ops: [], dropped: 1 })
  })
  it('extra unknown keys are stripped from the parsed op (not present in result)', () => {
    const r = parseExtractResponse(`{"ops":[{"op":"touch","id":"thr_1",${ep},"unknownField":"should-be-gone"}]}`)
    expect(r).not.toBeNull()
    expect(r!.ops[0]).not.toHaveProperty('unknownField')
  })
  it('update with only id is parsed (documents the no-op contract)', () => {
    const r = parseExtractResponse('{"ops":[{"op":"update_topic","id":"thr_abc"}]}')
    expect(r).not.toBeNull()
    expect(r!.ops.length).toBe(1)
    expect(r!.ops[0]).toMatchObject({ op: 'update_topic', id: 'thr_abc' })
  })
  it('A4: episode with +08:00 offset ts → entire batch rejected (returns null)', () => {
    // T1 起:只丢这一条(dropped),不再整批作废 —— 一条写错就让水位永远卡住更糟
    const r = parseExtractResponse('{"ops":[{"op":"touch","id":"t","episode":{"from_ts":"2026-06-11T09:00:00+08:00","to_ts":"2026-06-11T09:01:00+08:00"}}]}')
    expect(r).toEqual({ ops: [], dropped: 1 })
  })
  it('A4: valid Z-suffix ts passes schema', () => {
    const r = parseExtractResponse('{"ops":[{"op":"touch","id":"t","episode":{"from_ts":"2026-06-11T01:00:00Z","to_ts":"2026-06-11T01:01:00Z"}}]}')
    expect(r!.ops.length).toBe(1)
    expect(r!.dropped).toBe(0)
  })
  it('A4: ts with milliseconds and Z suffix passes schema', () => {
    const r = parseExtractResponse('{"ops":[{"op":"touch","id":"thr_1","episode":{"from_ts":"2026-06-11T01:00:00.123Z","to_ts":"2026-06-11T01:01:00.456Z"}}]}')
    expect(r!.ops.length).toBe(1)
  })
  it('A4: prompt contains the UTC timestamp rule', () => {
    const p = buildExtractPrompt({ newMessages: [], existingThreads: [], tagVocabulary: [] })
    expect(p).toContain('时间戳必须原样复制')
    expect(p).toContain('UTC')
    expect(p).toContain('Z 结尾')
  })
  it('contextTail appears in prompt under the reappearance header', () => {
    const p = buildExtractPrompt({
      newMessages: [{ ts: '2026-06-11T02:00:00Z', direction: 'in', text: '排产又提了一次' }], existingThreads: [], tagVocabulary: [],
      contextTail: [{ ts: '2026-06-10T20:00:00Z', direction: 'in', text: '上次说的排产问题' }, { ts: '2026-06-10T20:01:00Z', direction: 'out', text: '好的我记下了' }],
    })
    expect(p).toContain('近期历史(只用来判断话题是不是又聊到了')
    expect(p).toContain('上次说的排产问题')
    expect(p).toContain('好的我记下了')
    const tailPos = p.indexOf('近期历史'), newMsgPos = p.indexOf('=== 新增对话片段 ===')
    expect(tailPos).toBeGreaterThan(-1)
    expect(tailPos).toBeLessThan(newMsgPos)
  })
})

// 2026-11-13:新消息全文送去抽取,但单条有上限——不设上限时一条超出便宜模型窗口的消息会让水位永远不动。
import { renderMessage as renderForCap, NEW_TEXT_MAX as CAP } from './extract-prompt'
describe('new-message cap for extraction', () => {
  it('sends an ordinary long message in full, including its middle', () => {
    const text = 'a'.repeat(8000) + 'MIDDLE_FACT' + 'b'.repeat(8000)
    expect(renderForCap({ ts: '2026-11-13T00:00:00Z', direction: 'in', text })).toContain('MIDDLE_FACT')
  })
  it('keeps head and tail of an oversized paste and says how much was left out', () => {
    const text = 'HEAD_FACT' + 'x'.repeat(60000) + 'TAIL_FACT'
    const out = renderForCap({ ts: '2026-11-13T00:00:00Z', direction: 'in', text })
    expect(out).toContain('HEAD_FACT'); expect(out).toContain('TAIL_FACT')
    expect(out).toContain(`中间略去 ${text.length - CAP} 字`)
    expect(out.length).toBeLessThan(CAP + 200)
  })
})
