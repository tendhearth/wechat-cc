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
  it('既有机器流水摘要和条目不再喂给抽取模型', async () => {
    const { db, messages, threads } = setup()
    try {
      const id = await threads.create({ chatId: 'c1', title: 'wechat-cc', description: '个人 AI 项目', summary: '个人 AI 项目。现状:Codex升至0.167.0自检过', facets: ['task'], tags: [], private: false, episodes: [] })
      await threads.addEntry({ threadId: id, kind: 'progress', line: 'Codex升至0.167.0自检过' })
      await messages.append({ id: 'ask', chatId: 'c1', ts: '2026-06-11T02:00:00Z', direction: 'in', kind: 'text', text: '决定把手机验收补齐', source: 'live' })
      let prompt = ''
      await runThreadsExtraction({ chatId: 'c1', messages, threads, ...quiet, sdkEval: async p => { prompt = p; return '{"ops":[]}' } })
      expect(prompt).not.toContain('0.167.0')
      expect(prompt).toContain('个人 AI 项目')
    } finally { db.close() }
  })

  it('模型仍吐出纯机器回执时,create/add/update 都不能写入条目', async () => {
    const { db, messages, threads } = setup()
    try {
      const id = await threads.create({ chatId: 'c1', title: 'wechat-cc', summary: '', facets: ['task'], tags: [], private: false, episodes: [] })
      const existing = await threads.addEntry({ threadId: id, kind: 'decision', line: '决定统一手机入口' })
      await messages.append({ id: 'ask', chatId: 'c1', ts: '2026-06-11T02:00:00Z', direction: 'in', kind: 'text', text: '手机入口待补', source: 'live' })
      const receipt = 'Codex升至0.167.0自检过'
      await runThreadsExtraction({ chatId: 'c1', messages, threads, ...quiet, sdkEval: async () => JSON.stringify({ ops: [
        { op: 'add_entry', topic: id, kind: 'progress', line: receipt },
        { op: 'update_entry', id: existing, line: receipt },
        { op: 'create_topic', title: '工具链', summary: '', facets: ['task'], tags: [], private: false, entries: [{ kind: 'progress', line: receipt }] },
      ] }) })
      const all = [...(await threads.entriesByThread('c1')).values()].flat()
      expect(all.map(e => e.line)).toEqual(['决定统一手机入口'])
      expect((await threads.getExtractState('c1')).entriesToTs).toBe('2026-06-11T02:00:00Z')
    } finally { db.close() }
  })
  it('例行通知不占模型批次或历史上下文;主人的升级开发决定仍保留', async () => {
    const { db, messages, threads } = setup()
    try {
      await messages.append({ id: 'old', chatId: 'c1', ts: '2026-06-10T01:00:00Z', direction: 'out', kind: 'text', text: 'old routine marker', source: 'speech:upgrade_notice' })
      await threads.setExtractState('c1', { entriesToTs: '2026-06-10T01:00:00Z' })
      await messages.append({ id: 'auto', chatId: 'c1', ts: '2026-06-11T01:00:00Z', direction: 'out', kind: 'text', text: 'new routine marker', source: 'speech:upgrade_notice' })
      let calls = 0
      await runThreadsExtraction({ chatId: 'c1', messages, threads, ...quiet, sdkEval: async () => { calls++; return '{"ops":[]}' } })
      expect(calls).toBe(0)
      expect((await threads.getExtractState('c1')).entriesToTs).toBe('2026-06-11T01:00:00Z')
      await messages.append({ id: 'ask', chatId: 'c1', ts: '2026-06-11T02:00:00Z', direction: 'in', kind: 'text', text: '决定修复 CLI 自动升级的回滚漏洞', source: 'live' })
      let prompt = ''
      await runThreadsExtraction({ chatId: 'c1', messages, threads, ...quiet, sdkEval: async p => { prompt = p; return '{"ops":[]}' } })
      expect(prompt).not.toContain('routine marker')
      expect(prompt).toContain('决定修复 CLI 自动升级的回滚漏洞')
    } finally { db.close() }
  })

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
    expect(t).toMatchObject({ title: 'bx', aliases: ['bx server'], lastActive: '2026-06-11T01:00:00Z', description: '自托管网络工具' })
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

// 原有用例搬到新的操作形状和新水位上(T1)
describe('threads extractor · 原有用例', () => {
  const ts = (h: number) => `2026-06-11T0${h}:00:00Z`
  it('excludes explicit workbench provenance from both new messages and context tail, preserving other commands', async () => {
    const { messages, threads } = setup()
    const rows = [['1', 'workbench', 'private old input'], ['2', 'live', 'ordinary old chat'], ['3', 'workbench', 'private result'], ['4', 'live', '/ordinary-command'], ['5', 'workbench', 'private latest']]
    for (const [id, source, text] of rows) await messages.append({ id: id!, chatId: 'c1', ts: `2026-06-11T01:00:0${id}Z`, direction: id === '3' ? 'out' : 'in', kind: 'command', text: text!, source: source! })
    await threads.setExtractState('c1', { entriesToTs: '2026-06-11T01:00:02Z' })
    let prompt = ''
    await runThreadsExtraction({ chatId: 'c1', messages, threads, ...quiet, sdkEval: async v => { prompt = v; return '{"ops":[]}' } })
    for (const marker of ['private old input', 'private result', 'private latest']) expect(prompt).not.toContain(marker)
    expect(prompt).toContain('ordinary old chat')
    expect(prompt).toContain('/ordinary-command')
    expect((await threads.getExtractState('c1')).entriesToTs).toBe('2026-06-11T01:00:05Z')
    expect(await messages.listSince('c1', '1970', 10)).toHaveLength(5)
  })
  it('update op on unknown id is skipped, others still apply', async () => {
    const { messages, threads } = setup()
    await messages.append({ id: '1', chatId: 'c1', ts: ts(1), direction: 'in', kind: 'text', text: 'x', source: 'live' })
    const res = await runThreadsExtraction({ chatId: 'c1', messages, threads, ...quiet,
      sdkEval: async () => JSON.stringify({ ops: [{ op: 'touch', id: 'thr_ghost', episode: ep(ts(1)) }, { op: 'create_topic', title: 'y', summary: '', facets: ['life'], tags: [], private: false, episode: ep(ts(1)) }] }) })
    expect(res.applied).toBe(1)
    expect(res.skipped).toBe(1)
  })
  it('contextTail is passed to buildExtractPrompt when pre-watermark messages exist', async () => {
    const { messages, threads } = setup()
    await messages.append({ id: '1', chatId: 'c1', ts: ts(1), direction: 'in', kind: 'text', text: 'old message', source: 'live' })
    await threads.setExtractState('c1', { entriesToTs: ts(1) })
    await messages.append({ id: '2', chatId: 'c1', ts: ts(2), direction: 'in', kind: 'text', text: '新消息', source: 'live' })
    let captured = ''
    await runThreadsExtraction({ chatId: 'c1', messages, threads, ...quiet, sdkEval: async p => { captured = p; return '{"ops":[]}' } })
    expect(captured).toContain('old message')
    expect(captured).toContain('近期历史')
  })
  it('empty ops list advances watermark and records event', async () => {
    const { messages, threads } = setup()
    await messages.append({ id: '1', chatId: 'c1', ts: ts(5), direction: 'out', kind: 'text', text: 'hi', source: 'live' })
    let eventRecorded = false
    const res = await runThreadsExtraction({ chatId: 'c1', messages, threads, log: () => {}, recordEvent: async () => { eventRecorded = true }, sdkEval: async () => '{"ops":[]}' })
    expect(res.applied).toBe(0)
    expect(res.skipped).toBe(0)
    expect((await threads.getExtractState('c1')).entriesToTs).toBe(ts(5))
    expect(eventRecorded).toBe(true)
  })
  it('update op on known id applies (touch adds episode, lastActive)', async () => {
    const { messages, threads } = setup()
    await messages.append({ id: '1', chatId: 'c1', ts: ts(3), direction: 'in', kind: 'text', text: 'follow-up on排产', source: 'live' })
    const tId = await threads.create({ chatId: 'c1', title: '排产', summary: '', facets: ['task'], tags: [], private: false, episodes: [ep('2026-06-10T00:00:00Z')], lastActive: '2026-06-10T00:00:00Z' })
    const res = await runThreadsExtraction({ chatId: 'c1', messages, threads, ...quiet, sdkEval: async () => JSON.stringify({ ops: [{ op: 'touch', id: tId, episode: ep(ts(3)) }] }) })
    expect(res.applied).toBe(1)
    expect(res.skipped).toBe(0)
    const updated = await threads.get(tId)
    expect(updated?.episodes.length).toBe(2)
    expect(updated?.lastActive).toBe(ts(3))
  })
  it('applies create ops and advances watermark to last message ts', async () => {
    const { messages, threads } = setup()
    await messages.append({ id: '1', chatId: 'c1', ts: '2026-06-11T01:00:00Z', direction: 'in', kind: 'text', text: '排产', source: 'live' })
    const res = await runThreadsExtraction({ chatId: 'c1', messages, threads, ...quiet,
      sdkEval: async () => JSON.stringify({ ops: [{ op: 'create_topic', title: '排产', summary: 's', facets: ['task'], tags: [], private: false, episode: ep('2026-06-11T01:00:00Z') }] }) })
    expect(res.applied).toBe(1)
    expect((await threads.list('c1')).length).toBe(1)
    expect((await threads.getExtractState('c1')).entriesToTs).toBe('2026-06-11T01:00:00Z')
  })
})
