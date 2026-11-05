import { describe, it, expect } from 'vitest'
import { openTestDb } from '../../lib/db'
import { makeMessagesStore } from '../../lib/messages-store'
import { makeThreadsStore } from '../../lib/threads-store'
import { runThreadsExtraction, BATCH_CHARS } from './extractor'
import type { WorkResult } from './work-results'

function setup() {
  const db = openTestDb()
  return { db, messages: makeMessagesStore(db), threads: makeThreadsStore(db) }
}
const quiet = { log: () => {}, recordEvent: async () => {} }
const ep = (ts: string) => ({ from_ts: ts, to_ts: ts })

describe('threads extractor (话题 T1)', () => {
  it('CC 发的工作台通知不进提示词,水位照样越过它们', async () => {
    const { messages, threads } = setup()
    const rows = [['1', 'workbench', 'private notice 1'], ['2', 'live', 'ordinary chat'], ['3', 'workbench', 'private notice 2']]
    for (const [id, source, text] of rows) await messages.append({ id: id!, chatId: 'c1', ts: `2026-06-11T01:00:0${id}Z`, direction: 'in', kind: 'text', text: text!, source: source! })
    let prompt = ''
    await runThreadsExtraction({ chatId: 'c1', messages, threads, ...quiet, sdkEval: async p => { prompt = p; return '{"ops":[]}' } })
    expect(prompt).not.toContain('private notice')
    expect(prompt).toContain('ordinary chat')
    expect((await threads.getExtractState('c1')).entriesToTs).toBe('2026-06-11T01:00:03Z')
  })

  it('只有通知的一批:不叫模型,水位往前走', async () => {
    const { messages, threads } = setup()
    await messages.append({ id: 'p', chatId: 'c1', ts: '2026-06-11T01:00:01Z', direction: 'out', kind: 'text', text: 'notice', source: 'workbench' })
    let calls = 0
    await runThreadsExtraction({ chatId: 'c1', messages, threads, ...quiet, sdkEval: async () => { calls++; return '{"ops":[]}' } })
    expect(calls).toBe(0)
    expect((await threads.getExtractState('c1')).entriesToTs).toBe('2026-06-11T01:00:01Z')
  })

  it('create_topic 带条目;承诺单独一条带期限;老水位不动', async () => {
    const { messages, threads } = setup()
    await messages.append({ id: '1', chatId: 'c1', ts: '2026-06-11T01:00:00Z', direction: 'in', kind: 'text', text: 'bx 下周发 0.5,答应小王 20 号前给他装上', source: 'live' })
    const res = await runThreadsExtraction({
      chatId: 'c1', messages, threads, ...quiet,
      sdkEval: async () => JSON.stringify({ ops: [{ op: 'create_topic', title: 'bx', summary: '自托管网络工具', facets: ['task'], tags: ['产品开发'], aliases: ['bx server'], private: false, episode: ep('2026-06-11T01:00:00Z'),
        entries: [{ kind: 'progress', line: 'bx 0.5 计划下周发' }, { kind: 'commitment', line: '答应小王 20 号前装好 bx', due: '2026-06-20' }] }] }),
    })
    expect(res.applied).toBe(1)
    const [t] = await threads.list('c1')
    expect(t).toMatchObject({ title: 'bx', aliases: ['bx server'], lastActive: '2026-06-11T01:00:00Z' })
    const es = await threads.entries(t!.id)
    expect(es.map(e => [e.kind, e.due, e.source]).sort()).toEqual([['commitment', '2026-06-20', 'chat'], ['progress', null, 'chat']])
  })

  it('add_entry / update_entry / touch 只认这个对话里的话题和条目', async () => {
    const { messages, threads } = setup()
    const mine = await threads.create({ chatId: 'c1', title: 'bx', summary: '', facets: ['task'], tags: [], private: false, episodes: [] })
    const other = await threads.create({ chatId: 'c2', title: 'x', summary: '', facets: ['task'], tags: [], private: false, episodes: [] })
    const old = await threads.addEntry({ threadId: mine, kind: 'commitment', line: '答应装 bx' })
    const foreign = await threads.addEntry({ threadId: other, kind: 'fact', line: '别人的' })
    await messages.append({ id: '1', chatId: 'c1', ts: '2026-06-11T02:00:00Z', direction: 'in', kind: 'text', text: '装好了', source: 'live' })
    const res = await runThreadsExtraction({
      chatId: 'c1', messages, threads, ...quiet,
      sdkEval: async () => JSON.stringify({ ops: [
        { op: 'update_entry', id: old, status: 'done' },
        { op: 'update_entry', id: foreign, status: 'superseded' },
        { op: 'add_entry', topic: other, kind: 'fact', line: '伸手' },
        { op: 'add_entry', topic: mine, kind: 'fact', line: 'bx 装在 mini 上' },
        { op: 'touch', id: mine, episode: ep('2026-06-11T02:00:00Z') },
        { op: 'add_entry', topic: mine, kind: 'bogus', line: '字段写错只丢这一条' },
      ] }),
    })
    expect(res).toMatchObject({ applied: 3, skipped: 3 })
    expect((await threads.getEntry(old))!.status).toBe('done')
    expect((await threads.getEntry(foreign))!.status).toBe('live')
    expect((await threads.entries(other)).length).toBe(1)
    expect((await threads.get(mine))!.episodes).toEqual([ep('2026-06-11T02:00:00Z')])
  })

  it('没有新消息 ⇒ 不叫模型', async () => {
    const { messages, threads } = setup()
    let calls = 0
    await runThreadsExtraction({ chatId: 'c1', messages, threads, ...quiet, sdkEval: async () => { calls++; return '{"ops":[]}' } })
    expect(calls).toBe(0)
  })

  it('解析失败 ⇒ 水位不动', async () => {
    const { messages, threads } = setup()
    await messages.append({ id: '1', chatId: 'c1', ts: '2026-06-11T01:00:00Z', direction: 'in', kind: 'text', text: 'x', source: 'live' })
    await runThreadsExtraction({ chatId: 'c1', messages, threads, ...quiet, sdkEval: async () => 'garbage' })
    expect((await threads.getExtractState('c1')).entriesToTs).toBeNull()
  })

  it('空输出 / 想光了 ⇒ 同一批重试一次', async () => {
    const { messages, threads } = setup()
    await messages.append({ id: '1', chatId: 'c1', ts: '2026-06-11T01:00:00Z', direction: 'in', kind: 'text', text: 'x', source: 'live' })
    const answers: Array<() => string> = [
      () => { const e = new Error('eval_output_exhausted: m spent…'); e.name = 'EvalOutputExhaustedError'; throw e },
      () => '{"ops":[]}',
    ]
    let calls = 0
    await runThreadsExtraction({ chatId: 'c1', messages, threads, ...quiet, sdkEval: async () => answers[calls++]!() })
    expect(calls).toBe(2)
    expect((await threads.getExtractState('c1')).entriesToTs).toBe('2026-06-11T01:00:00Z')

    const { messages: m2, threads: t2 } = setup()
    await m2.append({ id: '1', chatId: 'c1', ts: '2026-06-11T01:00:00Z', direction: 'in', kind: 'text', text: 'x', source: 'live' })
    let n = 0
    await runThreadsExtraction({ chatId: 'c1', messages: m2, threads: t2, ...quiet, sdkEval: async () => { n++; return '  ' } })
    expect(n).toBe(2)
    expect((await t2.getExtractState('c1')).entriesToTs).toBeNull()
  })

  it('别的错照抛(网络守护拒了之类),水位不动', async () => {
    const { messages, threads } = setup()
    await messages.append({ id: '1', chatId: 'c1', ts: '2026-06-11T01:00:00Z', direction: 'in', kind: 'text', text: 'x', source: 'live' })
    await expect(runThreadsExtraction({ chatId: 'c1', messages, threads, ...quiet, sdkEval: async () => { throw new Error('network_unprotected') } })).rejects.toThrow('network_unprotected')
    expect((await threads.getExtractState('c1')).entriesToTs).toBeNull()
  })

  it('历史太长按字数切批,一拍跑多批', async () => {
    const { messages, threads } = setup()
    const big = 'x'.repeat(400)
    for (let i = 0; i < 300; i++) await messages.append({ id: `m${i}`, chatId: 'c1', ts: new Date(Date.UTC(2026, 5, 11, 0, 0, i)).toISOString(), direction: 'in', kind: 'text', text: big, source: 'live' })
    const sizes: number[] = []
    const res = await runThreadsExtraction({ chatId: 'c1', messages, threads, ...quiet, sdkEval: async p => { sizes.push((p.split('=== 新增对话片段 ===')[1]!.match(/\] 主人: x/g) ?? []).length); return '{"ops":[]}' } })
    expect(res.rounds).toBeGreaterThan(1)
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(300)
    expect(Math.max(...sizes) * 430).toBeLessThan(BATCH_CHARS + 1000)
    expect((await threads.getExtractState('c1')).entriesToTs).toBe(new Date(Date.UTC(2026, 5, 11, 0, 0, 299)).toISOString())
  })

  it('agent 的活:结论进提示词,结论条目指回那件事,编的编号不认;work 水位推进', async () => {
    const { messages, threads } = setup()
    const work: WorkResult[] = [{ matterId: 'm1', kind: 'terminal', title: 'bx', project: 'bx', state: 'done', ask: '修 DNS', result: '改了 resolv 顺序,91 上 dig 通过', at: '2026-06-11T03:00:00Z', cursor: 42 }]
    let prompt = ''
    await runThreadsExtraction({
      chatId: 'c1', messages, threads, ...quiet,
      work: after => (after < 42 ? { results: work, nextCursor: 50 } : { results: [], nextCursor: after }),
      sdkEval: async p => { prompt = p; return JSON.stringify({ ops: [{ op: 'create_topic', title: 'bx', summary: '', facets: ['task'], tags: [], aliases: [], private: false,
        entries: [{ kind: 'conclusion', line: 'bx DNS 修好:改 resolv 顺序', matter: 'm1' }, { kind: 'conclusion', line: '编的', matter: 'zzz' }] }] }) },
    })
    expect(prompt).toContain('改了 resolv 顺序')
    expect(prompt).toContain('要求: 修 DNS')
    const [t] = await threads.list('c1')
    const es = await threads.entries(t!.id)
    expect(es.find(e => e.line.startsWith('bx DNS'))).toMatchObject({ source: 'work', matterId: 'm1' })
    expect(es.find(e => e.line === '编的')).toMatchObject({ source: 'chat', matterId: null })
    expect((await threads.getExtractState('c1')).workCursor).toBe(50)
  })
})
