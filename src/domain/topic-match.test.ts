import { describe, it, expect } from 'vitest'
import { isSubstantiveTopicQuery, keyIn, matchTopics, parseTopicJudge, pickEntries, renderTopicsBlock, tokens, topicJudgePrompt, TOPIC_FALLBACK_MIN_CHARS, TOPIC_JUDGE_MAX_ENTRIES, TOPIC_JUDGE_ENTRY_CHARS, type MatchTopic } from './topic-match'

const e = (id: string, kind: MatchTopic['entries'][number]['kind'], line: string, updatedTs = '2026-11-01T00:00:00Z', body = '', due: string | null = null) => ({ id, kind, line, body, due, updatedTs })
const servers: MatchTopic = { id: 'srv', title: '服务器', summary: '自用机队:91、166、mini', aliases: ['机队', 'mini', '91'], tags: ['运维'], lastActive: '', entries: [
  e('s1', 'fact', '166.88.197.165 被商家重置,重装了 brook + bx server', '2026-09-02T00:00:00Z'),
  e('s2', 'fact', 'Mac mini M4 在局域网 215,ssh beef'),
  e('s3', 'commitment', '答应给 91 换硬盘', '2026-10-01T00:00:00Z', '', '2026-11-20'),
] }
const bx: MatchTopic = { id: 'bx', title: 'bx', summary: '自托管网络工具,AI 友好的代理 appliance', aliases: ['bx server', '代理'], tags: ['产品开发'], lastActive: '', entries: [
  e('b1', 'decision', 'bx 升级走 --force,dev 版不自动升'),
] }
const writter: MatchTopic = { id: 'wr', title: 'writter', summary: '写作工具,界面重构与修订主流程', aliases: ['NC', '写作工具'], tags: ['产品开发'], lastActive: '', entries: [] }
const all = [servers, bx, writter]

describe('keyIn', () => {
  it('英文按词边界、不分大小写;中文至少两个字', () => {
    expect(keyIn('bx', 'BX 又断了')).toBe(true)
    expect(keyIn('bx', '看下 inbox')).toBe(false)
    expect(keyIn('bx', '那个bx是不是挂了')).toBe(true)
    expect(keyIn('91', '191 号')).toBe(false)
    expect(keyIn('服务器', '服务器又挂了')).toBe(true)
    expect(keyIn('机', '机器')).toBe(false)
    expect(keyIn('  ', 'x')).toBe(false)
  })
})

describe('matchTopics', () => {
  it('精确:标题 / 别名原样出现 ⇒ 直接碰到,不要模型', () => {
    expect(matchTopics('服务器又挂了', all)).toEqual({ hits: [{ id: 'srv', score: 103, via: 'exact' }], ambiguous: [] })
    expect(matchTopics('mini 上那个 ssh 怎么连', all).hits.map(h => h.id)).toEqual(['srv'])
    expect(matchTopics('bx 和 writter 哪个先发', all).hits.map(h => h.id).sort()).toEqual(['bx', 'wr'])
  })
  it('近似:没提名字,但条目里的词撞上好几个 ⇒ 碰到', () => {
    const r = matchTopics('那台被商家重置的机器,brook 现在还能用吗', all)
    expect(r.hits).toMatchObject([{ id: 'srv', via: 'near' }])
  })
  it('两个话题都只沾一点、分不开 ⇒ 拿不准,交候选', () => {
    const a: MatchTopic = { id: 'a', title: 'alpha', summary: '界面改版、配色', aliases: [], tags: [], lastActive: '', entries: [] }
    const b: MatchTopic = { id: 'b', title: 'beta', summary: '界面配色方案', aliases: [], tags: [], lastActive: '', entries: [] }
    const r = matchTopics('界面配色', [a, b, bx])
    expect(r.hits).toEqual([])
    expect(r.ambiguous.map(x => x.id).sort()).toEqual(['a', 'b'])
  })
  it('只有一个话题沾边、撞上两个不同的词 ⇒ 算碰到(不叫模型)', () => {
    expect(matchTopics('那个工具界面', all).hits).toMatchObject([{ id: 'wr', via: 'near' }])
  })
  it('只撞上一个词 ⇒ 不算(也不叫模型)', () => {
    expect(matchTopics('硬盘', [bx, writter, { ...servers, aliases: [], title: '机器' }])).toEqual({ hits: [], ambiguous: [] })
  })
  it('闲聊一句 ⇒ 什么都不交(不叫模型)', () => {
    expect(matchTopics('早上好,今天吃了吗', all)).toEqual({ hits: [], ambiguous: [] })
    expect(matchTopics('好的谢谢', all)).toEqual({ hits: [], ambiguous: [] })
  })
})

describe('judge / render', () => {
  it('提示词列候选和别名;单独一个数字才算数', () => {
    const p = topicJudgePrompt('那个工具', [writter, bx])
    expect(p).toContain('1. writter(也叫:NC、写作工具)')
    expect(parseTopicJudge('1', [writter, bx])).toEqual({ topicId: 'wr' })
    expect(parseTopicJudge(' 2\n', [writter, bx])).toEqual({ topicId: 'bx' })
    expect(parseTopicJudge('0', [writter, bx])).toBeNull()
    expect(parseTopicJudge('1 或 2', [writter, bx])).toBeNull()
    expect(parseTopicJudge('3', [writter, bx])).toBeNull()
    expect(parseTopicJudge('', [writter, bx])).toBeNull()
  })
  it('零候选兜底只接够长且有不同实词的句子,不接短问句或寒暄', () => {
    expect(isSubstantiveTopicQuery('开视频会议的时候浏览器会把真实 IP 漏出去吗')).toBe(true)
    expect(isSubstantiveTopicQuery('浏览器开会时暴露了本机地址')).toBe(true)
    expect(isSubstantiveTopicQuery('The browser exposes my public address during calls')).toBe(true)
    expect(isSubstantiveTopicQuery('今天好累啊，先歇会儿')).toBe(false)
    expect(isSubstantiveTopicQuery('早上好，今天吃了吗？')).toBe(false)
    expect(isSubstantiveTopicQuery('hi, how are you?')).toBe(false)
    expect(isSubstantiveTopicQuery('漏 IP 吗？')).toBe(false)
    expect(isSubstantiveTopicQuery('？！ '.repeat(20))).toBe(false)
    expect(isSubstantiveTopicQuery('你好'.repeat(20))).toBe(false)
    expect(isSubstantiveTopicQuery('甲乙丙丁戊己庚辛壬癸子丑'.slice(0, TOPIC_FALLBACK_MIN_CHARS - 1) + '？！')).toBe(false)
    expect(isSubstantiveTopicQuery('甲乙丙丁戊己庚辛壬癸子丑')).toBe(true)
  })
  it('提示词给条目编号、限条数和行长;解析只认展示过的编号', () => {
    const many: MatchTopic = { ...servers, entries: Array.from({ length: TOPIC_JUDGE_MAX_ENTRIES + 1 }, (_, i) => e(`s${i}`, 'fact', `条目${i}:` + '甲'.repeat(200))) }
    const prompt = topicJudgePrompt('开会是否暴露本机地址', [bx, many])
    expect(prompt).toContain('1.1 bx 升级走 --force')
    expect(prompt).toContain(`2.${TOPIC_JUDGE_MAX_ENTRIES} 条目${TOPIC_JUDGE_MAX_ENTRIES - 1}:`)
    expect(prompt).not.toContain(`2.${TOPIC_JUDGE_MAX_ENTRIES + 1} `)
    expect(prompt).not.toContain('甲'.repeat(TOPIC_JUDGE_ENTRY_CHARS + 1))
    expect(parseTopicJudge(' 2.3\n', [bx, many])).toEqual({ topicId: 'srv', entryId: 's2' })
    expect(parseTopicJudge(`2.${TOPIC_JUDGE_MAX_ENTRIES + 1}`, [bx, many])).toEqual({ topicId: 'srv' })
    expect(parseTopicJudge('1.2', [bx, many])).toEqual({ topicId: 'bx' })
    expect(parseTopicJudge('1.0', [bx, many])).toEqual({ topicId: 'bx' })
    expect(parseTopicJudge('3.1', [bx, many])).toBeNull()
    expect(parseTopicJudge('0.1', [bx, many])).toBeNull()
  })
  it.each(['话题 2', '2.', '2.1 因为有关', '2\n1', '```\n2\n```', '-2', '02', '2.01', '2.1.1'])('拒绝非完整编号回答 %s', answer => {
    expect(parseTopicJudge(answer, [servers, bx])).toBeNull()
  })
  it('挑条目:先重合,再没兑现的承诺,再新近', () => {
    expect(pickEntries('brook 还能用吗', servers).map(x => x.id)).toEqual(['s1', 's3', 's2'])
    expect(pickEntries('随便', servers).map(x => x.id)).toEqual(['s3', 's2', 's1'])
  })
  it('模型点名排在字面重合/承诺前,渲染和条目选择保持一致且不重复', () => {
    expect(pickEntries('brook', servers, 2, 's2').map(x => x.id)).toEqual(['s2', 's1'])
    expect(pickEntries('brook', servers, 2, 'gone').map(x => x.id)).toEqual(['s1', 's3'])
    const block = renderTopicsBlock('brook', [servers], undefined, { preferredEntryIds: new Map([['srv', 's2']]) })
    expect(block.split('\n')[1]).toContain('Mac mini M4')
    expect(block.match(/Mac mini M4/g)).toHaveLength(1)
  })
  it('渲染:话题一行 + 条目,承诺带期限;超长截断', () => {
    const b = renderTopicsBlock('brook', [servers])
    expect(b.split('\n')[0]).toBe('话题「服务器」—— 自用机队:91、166、mini')
    expect(b).toContain('- [承诺] 答应给 91 换硬盘(期限 2026-11-20)')
    expect([...renderTopicsBlock('x', [servers, bx], 30)].length).toBe(31)
    const withBody: MatchTopic = { ...bx, entries: [e('b9', 'fact', 'bx 在 166', '2026-11-01T00:00:00Z', '细节在这')] }
    expect(renderTopicsBlock('bx', [withBody])).toContain(':细节在这')
    expect(renderTopicsBlock('bx', [withBody], undefined, { bodies: false })).not.toContain('细节在这')
  })
  it('tokens:中文二字词 + 英文词,去掉常用虚词', () => {
    expect([...tokens('帮我看看 BX server')].sort()).toEqual(['bx', 'server'])
  })
})
