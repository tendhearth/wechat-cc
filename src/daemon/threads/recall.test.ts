// @repo-guard 仓库里的话题评测样例(eval/output/examples/topic-*.json)只靠索引也要全过
import { describe, it, expect, vi } from 'vitest'
import { openTestDb } from '../../lib/db'
import { makeThreadsStore } from '../../lib/threads-store'
import { makeTopicRecall, resolveTopicRecall, TOPIC_JUDGE_TIMEOUT_MS } from './recall'
import { matchTopics, pickEntries, MAX_ENTRIES, TOPIC_FALLBACK_MAX_CANDIDATES, type MatchTopic } from '../../domain/topic-match'

const t = (id: string, title: string, aliases: string[], lines: string[]): MatchTopic => ({
  id, title, summary: `${title} 的事`, aliases, tags: [], lastActive: '',
  entries: lines.map((line, i) => ({ id: `${id}-${i}`, kind: 'fact' as const, line, body: '', due: null, updatedTs: `2026-11-0${i + 1}T00:00:00Z` })),
})
const topics = [t('wr', 'writter', ['NC'], ['界面改版、配色']), t('bx', 'bx', [], ['界面配色方案'])]
const paraphrase = '开视频会议的时候浏览器会把真实 IP 漏出去吗'
// bx-2 的最小复现;无关条目用虚构内容,把旧 WebRTC 条目放到默认选择范围之外。
const oldWebRtc = { id: 'bx-webrtc', kind: 'fact' as const, line: 'bx防WebRTC泄漏：默认UDP走代理且v6 fail-closed', body: '保护已启用', due: null, updatedTs: '2020-01-01T00:00:00Z' }
const paraphraseTopics = [t('other', '绘画', [], ['构图及色彩']), { ...t('bx', 'bx', [], Array.from({ length: 8 }, (_, i) => `配置事项 ${i}`)), entries: [...t('bx', 'bx', [], Array.from({ length: 8 }, (_, i) => `配置事项 ${i}`)).entries, oldWebRtc] }]

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
  it('bx-2 零候选仍可问快模型,点名旧条目进入信封和 entryIds 最前', async () => {
    expect(matchTopics(paraphrase, paraphraseTopics)).toEqual({ hits: [], ambiguous: [] })
    expect(pickEntries(paraphrase, paraphraseTopics[1]!).map(e => e.id)).not.toContain(oldWebRtc.id)
    let calls = 0
    const logs: string[] = []
    const cheapEval = Object.assign(async (prompt: string) => {
      calls++
      expect(prompt).toContain('2.9 bx防WebRTC泄漏：默认UDP走代理且v6 fail-closed')
      return '2.9'
    }, { via: 'fake-fast' })
    const r = await resolveTopicRecall(paraphrase, paraphraseTopics, { cheapEval, log: (_tag, line) => logs.push(line) })
    expect(calls).toBe(1)
    expect(r).toMatchObject({ topicIds: ['bx'], via: 'model' })
    expect(r!.entryIds[0]).toBe(oldWebRtc.id)
    expect(r!.entryIds).toHaveLength(MAX_ENTRIES)
    expect(new Set(r!.entryIds).size).toBe(MAX_ENTRIES)
    expect(r!.block.split('\n')[1]).toContain(`${oldWebRtc.line}:${oldWebRtc.body}`)
    expect(logs.some(l => /reason=zero-candidates/.test(l) && /via=fake-fast/.test(l) && /elapsedMs=\d+/.test(l))).toBe(true)
    const brief = await resolveTopicRecall(paraphrase, paraphraseTopics, { cheapEval, bodies: false })
    expect(brief!.block.split('\n')[1]).toContain(oldWebRtc.line)
    expect(brief!.block).not.toContain(oldWebRtc.body)
  })
  it.each(['今天好累啊，先歇会儿', '早上好，今天吃了吗？', '好的谢谢', '漏 IP 吗？'])('闲聊或短句不增加模型调用: %s', async text => {
    const cheapEval = vi.fn(async () => '2.9')
    expect(await resolveTopicRecall(text, paraphraseTopics, { cheapEval })).toBeNull()
    expect(cheapEval).not.toHaveBeenCalled()
  })
  it('零候选只送最近活跃的前 N 个开着话题,不改输入顺序', async () => {
    const many = Array.from({ length: TOPIC_FALLBACK_MAX_CANDIDATES + 2 }, (_, i) => ({ ...t(`topic-${i}`, `project-${i}`, [], ['配置事项']), lastActive: `2026-11-${String(i + 1).padStart(2, '0')}T00:00:00Z` }))
    const before = many.map(t => t.id)
    const cheapEval = vi.fn(async (prompt: string) => {
      expect(prompt).toContain(`1. project-${many.length - 1}`)
      expect(prompt).toContain(`${TOPIC_FALLBACK_MAX_CANDIDATES}. project-2`)
      expect(prompt).not.toContain('project-1')
      expect(prompt).not.toContain('project-0')
      return '1'
    })
    const r = await resolveTopicRecall(paraphrase, many, { cheapEval })
    expect(r!.topicIds).toEqual([`topic-${many.length - 1}`])
    expect(cheapEval).toHaveBeenCalledTimes(1)
    expect(many.map(t => t.id)).toEqual(before)
  })
  it('分不开路径也用条目编号,日志说明原因', async () => {
    const cands = topics.map(x => ({ ...x, entries: [...x.entries, oldWebRtc] }))
    const matched = matchTopics('界面配色', cands)
    expect(matched.hits).toEqual([])
    expect(matched.ambiguous).toHaveLength(2)
    const selected = matched.ambiguous[0]!.id
    const logs: string[] = []
    const r = await resolveTopicRecall('界面配色', cands, { cheapEval: async prompt => {
      expect(prompt).toContain('1.2 bx防WebRTC泄漏')
      return '1.2'
    }, log: (_tag, line) => logs.push(line) })
    expect(r!.topicIds).toEqual([selected])
    expect(r!.entryIds[0]).toBe(oldWebRtc.id)
    expect(r!.block.split('\n')[1]).toContain(oldWebRtc.line)
    expect(logs.some(l => /reason=ambiguous/.test(l) && /elapsedMs=\d+/.test(l))).toBe(true)
  })
  it.each(['0', '', '话题 2', '2.9 因为有关', '2.', '99.1'])('零候选模型回 %j ⇒ null', async answer => {
    const cheapEval = vi.fn(async () => answer)
    expect(await resolveTopicRecall(paraphrase, paraphraseTopics, { cheapEval })).toBeNull()
    expect(cheapEval).toHaveBeenCalledTimes(1)
  })
  it('零候选模型抛错 / 未配置 ⇒ null', async () => {
    const cheapEval = vi.fn(async () => { throw new Error('fake failure') })
    expect(await resolveTopicRecall(paraphrase, paraphraseTopics, { cheapEval })).toBeNull()
    expect(cheapEval).toHaveBeenCalledTimes(1)
    expect(await resolveTopicRecall(paraphrase, paraphraseTopics, { cheapEval: null })).toBeNull()
  })
  it('零候选仍在 2.5s 截止,迟到回答不生效', async () => {
    vi.useFakeTimers()
    try {
      const logs: string[] = []
      let finish!: (s: string) => void
      const cheapEval = vi.fn(() => new Promise<string>(resolve => { finish = resolve }))
      const pending = resolveTopicRecall(paraphrase, paraphraseTopics, { cheapEval, log: (_tag, line) => logs.push(line) })
      expect(cheapEval).toHaveBeenCalledTimes(1)
      expect(TOPIC_JUDGE_TIMEOUT_MS).toBe(2500)
      await vi.advanceTimersByTimeAsync(TOPIC_JUDGE_TIMEOUT_MS)
      expect(await pending).toBeNull()
      expect(logs.some(l => /reason=zero-candidates/.test(l) && /topic_judge_timeout/.test(l))).toBe(true)
      expect(logs.some(l => /reason=zero-candidates/.test(l) && /elapsedMs=2500/.test(l))).toBe(true)
      finish('2.9')
      await Promise.resolve()
      expect(await pending).toBeNull()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
  it.each(['2.0', '2.10', '2.999'])('条目越界 %s 仍认话题,不改默认条目顺序', async answer => {
    const r = await resolveTopicRecall(paraphrase, paraphraseTopics, { cheapEval: async () => answer })
    expect(r!.topicIds).toEqual(['bx'])
    expect(r!.entryIds).toEqual(pickEntries(paraphrase, paraphraseTopics[1]!).map(e => e.id))
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
  it('零候选兜底也只看还开着话题的 live 条目', async () => {
    const db = openTestDb()
    try {
      const threads = makeThreadsStore(db)
      const a = await threads.create({ chatId: 'owner', title: 'bx', summary: '网络工具', facets: ['task'], tags: [], private: false, episodes: [] })
      const done = await threads.create({ chatId: 'owner', title: 'closed-project', summary: '', facets: ['task'], tags: [], private: false, episodes: [], status: 'done' })
      const live = await threads.addEntry({ threadId: a, kind: 'fact', line: oldWebRtc.line })
      const gone = await threads.addEntry({ threadId: a, kind: 'fact', line: 'obsolete-setting' })
      await threads.updateEntry(gone, { status: 'superseded' })
      await threads.addEntry({ threadId: done, kind: 'fact', line: 'closed-setting' })
      const cheapEval = vi.fn(async (prompt: string) => {
        expect(prompt).toContain(`1.1 ${oldWebRtc.line}`)
        expect(prompt).not.toContain('closed-project')
        expect(prompt).not.toContain('obsolete-setting')
        return '1.1'
      })
      const recall = makeTopicRecall({ threads, isOwner: c => c === 'owner', cheapEval: () => cheapEval, log: () => {} })
      expect(await recall('owner', paraphrase)).toMatchObject({ topicIds: [a], entryIds: [live], via: 'model' })
      expect(await recall('guest', paraphrase)).toBeNull()
      expect(cheapEval).toHaveBeenCalledTimes(1)
    } finally {
      db.close()
    }
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

describe('零候选兜底:评测样本里的话题可能没有 lastActive', () => {
  it('缺 lastActive 也照常问模型,不抛', async () => {
    const { resolveTopicRecall } = await import('./recall')
    const t = { id: 't1', title: 'bx', summary: '自托管网络', aliases: [], tags: [], entries: [{ id: 'e1', kind: 'fact', line: 'bx防WebRTC泄漏：默认UDP走代理', body: '', due: null, updatedTs: '' }] } as unknown as import('../../domain/topic-match').MatchTopic
    const r = await resolveTopicRecall('开视频会议的时候浏览器会把真实 IP 漏出去吗', [t, { ...t, id: 't2', title: '1in8b' }], { cheapEval: async () => '1.1' })
    expect(r?.topicIds).toEqual(['t1'])
    expect(r?.entryIds[0]).toBe('e1')
  })
})
