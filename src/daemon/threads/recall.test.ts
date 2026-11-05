// @repo-guard 仓库里的话题评测样例(eval/output/examples/topic-*.json)只靠索引也要全过
import { describe, it, expect } from 'vitest'
import { openTestDb } from '../../lib/db'
import { makeThreadsStore } from '../../lib/threads-store'
import { makeTopicRecall, resolveTopicRecall } from './recall'
import type { MatchTopic } from '../../domain/topic-match'

const t = (id: string, title: string, aliases: string[], lines: string[]): MatchTopic => ({
  id, title, summary: `${title} 的事`, aliases, tags: [], lastActive: '',
  entries: lines.map((line, i) => ({ id: `${id}-${i}`, kind: 'fact' as const, line, body: '', due: null, updatedTs: `2026-11-0${i + 1}T00:00:00Z` })),
})
const topics = [t('wr', 'writter', ['NC'], ['界面改版、配色']), t('bx', 'bx', [], ['界面配色方案'])]

describe('resolveTopicRecall', () => {
  it('精确命中不叫模型', async () => {
    let calls = 0
    const r = await resolveTopicRecall('writter 进度', topics, { cheapEval: async () => { calls++; return '1' } })
    expect(calls).toBe(0)
    expect(r).toMatchObject({ topicIds: ['wr'], entryIds: ['wr-0'], via: 'exact' })
    expect(r!.block).toContain('话题「writter」')
  })
  it('拿不准才问模型;模型回 0 / 空 / 抛错 / 超时 ⇒ 当没碰到', async () => {
    const ask = '界面配色'
    expect((await resolveTopicRecall(ask, topics, { cheapEval: async () => '1' }))).toMatchObject({ topicIds: [expect.any(String)], via: 'model' })
    expect(await resolveTopicRecall(ask, topics, { cheapEval: async () => '0' })).toBeNull()
    expect(await resolveTopicRecall(ask, topics, { cheapEval: async () => '' })).toBeNull()
    expect(await resolveTopicRecall(ask, topics, { cheapEval: async () => { const e = new Error('eval_output_exhausted'); e.name = 'EvalOutputExhaustedError'; throw e } })).toBeNull()
    expect(await resolveTopicRecall(ask, topics, { cheapEval: () => new Promise(() => {}), timeoutMs: 20 })).toBeNull()
    expect(await resolveTopicRecall(ask, topics, { cheapEval: null })).toBeNull()
  })
  it('没话题 / 太短 ⇒ null', async () => {
    expect(await resolveTopicRecall('writter', [], {})).toBeNull()
    expect(await resolveTopicRecall('w', topics, {})).toBeNull()
  })
})

describe('makeTopicRecall', () => {
  it('只在主人的对话里;只调还开着的话题和还算数的条目', async () => {
    const db = openTestDb()
    const threads = makeThreadsStore(db)
    const a = await threads.create({ chatId: 'owner', title: 'bx', summary: '网络工具', facets: ['task'], tags: [], private: false, episodes: [] })
    const done = await threads.create({ chatId: 'owner', title: 'writter', summary: '', facets: ['task'], tags: [], private: false, episodes: [], status: 'done' })
    await threads.addEntry({ threadId: a, kind: 'fact', line: 'bx 装在 mini 上' })
    const gone = await threads.addEntry({ threadId: a, kind: 'fact', line: 'bx 装在 91 上' })
    await threads.updateEntry(gone, { status: 'superseded' })
    await threads.addEntry({ threadId: done, kind: 'fact', line: 'writter 收工' })
    const logs: string[] = []
    const recall = makeTopicRecall({ threads, isOwner: c => c === 'owner', cheapEval: () => null, log: (_t, l) => logs.push(l) })
    const r = await recall('owner', 'bx 在哪台机器')
    expect(r!.block).toContain('bx 装在 mini 上')
    expect(r!.block).not.toContain('91')
    expect(await recall('owner', 'writter 呢')).toBeNull()
    expect(await recall('guest', 'bx 在哪台机器')).toBeNull()
    expect(logs.some(l => l.startsWith('recall chat=owner via=exact'))).toBe(true)
  })
  it('库坏了也不抛', async () => {
    const recall = makeTopicRecall({ threads: { list: async () => { throw new Error('boom') }, entriesByThread: async () => new Map() } as never, isOwner: () => true, cheapEval: () => null, log: () => {} })
    expect(await recall('owner', 'bx')).toBeNull()
  })
})

describe('仓库里的话题评测样例(eval/output/examples/topic-*.json)', () => {
  it('不叫模型、只靠索引也全过:换个说法也调出同一条,闲聊什么都不调', async () => {
    const { readdirSync, readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { parseSample, checkRule, effectiveRules } = await import('../../domain/output-eval')
    const dir = join(__dirname, '..', '..', '..', 'eval', 'output', 'examples')
    const files = readdirSync(dir).filter(f => f.startsWith('topic-') && f.endsWith('.json'))
    expect(files.length).toBeGreaterThanOrEqual(5)
    for (const f of files) {
      const p = parseSample(JSON.parse(readFileSync(join(dir, f), 'utf8')), f.slice(0, -5))
      if (!p.ok) throw new Error(`${f}: ${p.error}`)
      const topics = (p.sample.input.topics as Array<Record<string, unknown>>).map(t => ({
        ...(t as object), summary: String(t.summary ?? ''), aliases: (t.aliases ?? []) as string[], tags: (t.tags ?? []) as string[], lastActive: '',
        entries: ((t.entries ?? []) as Array<Record<string, unknown>>).map(e => ({ body: '', due: null, updatedTs: '', ...e })),
      })) as unknown as MatchTopic[]
      const text = String(p.sample.input.text)
      let recall: { topicIds: string[]; entryIds: string[]; via: string } | null
      if (p.sample.input.search === true) {
        const { searchTopics } = await import('../../domain/topic-match')
        const hits = searchTopics(text, topics)
        recall = hits.length ? { topicIds: hits.map(h => h.id), entryIds: hits.flatMap(h => h.entries.map(e => e.id)), via: 'search' } : null
      } else {
        const r = await resolveTopicRecall(text, topics, { cheapEval: null })
        recall = r ? { topicIds: r.topicIds, entryIds: r.entryIds, via: r.via } : null
      }
      for (const rule of effectiveRules(p.sample)) {
        const res = checkRule(rule, { kind: 'topic', recall })
        expect(res.ok, `${f}: ${res.rule} — ${res.detail}`).toBe(true)
      }
    }
  })
})

describe('makeTopicSearch(topic_search 工具)', () => {
  it('按相关度排、细节里的词也算;私密话题只有主人自己的对话搜得到', async () => {
    const { makeTopicSearch } = await import('./recall')
    const db = openTestDb()
    const threads = makeThreadsStore(db)
    const bx = await threads.create({ chatId: 'owner', title: 'bx', summary: '网络工具', facets: ['task'], tags: [], private: false, episodes: [] })
    await threads.addEntry({ threadId: bx, kind: 'conclusion', line: 'Google Meet 延迟高根因', body: 'UDP-over-TCP 队头阻塞,实时视频会卡' })
    const mom = await threads.create({ chatId: 'owner', title: '妈妈', summary: '', facets: ['life'], tags: [], private: true, episodes: [] })
    await threads.addEntry({ threadId: mom, kind: 'fact', line: '视频通话时妈妈那边总卡' })
    const search = makeTopicSearch({ threads, ownerChatId: () => 'owner' })
    expect((await search('owner', '视频 卡')).map(h => h.title).sort()).toEqual(['bx', '妈妈'])
    expect((await search('eval-x', '视频 卡')).map(h => h.title)).toEqual(['bx'])
    expect((await search(undefined, '视频 卡')).map(h => h.title)).toEqual(['bx'])
    expect(await search('owner', '   ')).toEqual([])
    expect((await search('owner', 'Meet'))[0]).toMatchObject({ title: 'bx', entries: [{ line: 'Google Meet 延迟高根因' }] })
  })
})
