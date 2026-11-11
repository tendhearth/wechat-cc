/**
 * 这一轮碰到哪个话题(话题 T2,设计稿 docs/superpowers/specs/2026-11-05-topics-t1-t3-design.md §T2)—— 纯函数,零 I/O。
 *
 *  1. 精确:标题 / 别名原样出现在这句话里(英文按词边界、不分大小写;中文至少 2 个字)⇒ 碰到;
 *  2. 近似:中文二字词 + 英文词,和「标题 + 别名 + 摘要 + 条目索引行」比重合;够多且明显高过第二名 ⇒ 碰到;
 *  3. 拿不准:交出候选(≤ 5),调用方去问快模型;零候选且句子够实在时,调用方用最近话题兜底。
 * 选好话题以后,每个话题挑几条最相关的条目、渲染成信封里的 `<topics>` 那一段。
 */

import { isRoutineTopicEntry, isRoutineTopicText } from './topic-noise'

export type TopicEntryKind = 'fact' | 'decision' | 'commitment' | 'progress' | 'conclusion'

export interface MatchEntry { id: string; kind: TopicEntryKind; line: string; body: string; due: string | null; updatedTs: string }
export interface MatchTopic { id: string; title: string; summary: string; aliases: string[]; tags: string[]; lastActive: string; entries: MatchEntry[] }

/** Legacy receipts must not influence matching, model candidates, summaries or selected entries. */
export function withoutRoutineTopicNoise(t: MatchTopic): MatchTopic {
  const state = t.summary.match(/^(.*?)。?现状[:：]([\s\S]*)$/)
  const summary = isRoutineTopicText(t.summary) ? '' : state && isRoutineTopicText(state[2]!) ? state[1]!.replace(/[。.;；]+$/, '') : t.summary
  return { ...t, summary, entries: t.entries.filter(e => !isRoutineTopicEntry(e)) }
}

export interface TopicMatch {
  /** 定了的话题(按分数从高到低)。 */
  hits: Array<{ id: string; score: number; via: 'exact' | 'near' | 'model' }>
  /** 拿不准、要问模型的候选(hits 为空时才有)。 */
  ambiguous: Array<{ id: string; score: number }>
}

export const MAX_TOPICS = 2
export const MAX_ENTRIES = 6
export const BLOCK_MAX = 1200
export const MAX_CANDIDATES = 5
/** 零候选兜底只给最近活跃的几个话题;短句 / 寒暄不多付一次模型延迟。 */
export const TOPIC_FALLBACK_MAX_CANDIDATES = 5
export const TOPIC_FALLBACK_MIN_CHARS = 12
export const TOPIC_FALLBACK_MIN_TOKENS = 3
/** 模型看有界的索引行,不看条目细节;编号对应话题原有的条目顺序。 */
export const TOPIC_JUDGE_MAX_ENTRIES = 12
export const TOPIC_JUDGE_ENTRY_CHARS = 100
/** 近似重合到这个分才算碰到,而且要比第二名高出 NEAR_MARGIN 倍。 */
export const NEAR_ACCEPT = 4
export const NEAR_MARGIN = 1.5
/** 低于这个分的连候选都不算(一个常见二字词撞上不值得叫模型)。 */
export const NEAR_MIN = 2

const STOP_BIGRAMS = new Set(['一下', '一个', '这个', '那个', '什么', '怎么', '我们', '你们', '他们', '现在', '今天', '昨天', '明天', '可以', '没有', '就是', '还是', '已经', '因为', '所以', '如果', '但是', '然后', '时候', '东西', '问题', '一些', '知道', '觉得', '看看', '帮我', '一起', '上次', '之前', '以前', '这样', '那样', '还有', '是不', '不是', '有没', '的话', '了吗', '好的', '谢谢', '我看', '你看', '我想', '你说', '我说', '一样', '比较', '应该', '需要', '是什', '么时', '怎样'])
const STOP_WORDS = new Set(['the', 'and', 'for', 'you', 'are', 'was', 'with', 'this', 'that', 'what', 'how', 'can', 'ok', 'hi', 'is', 'it', 'to', 'of', 'in', 'on', 'a', 'an'])

const norm = (s: string) => s.normalize('NFKC').toLowerCase()

/** 中文二字词 + 英文 / 数字词(≥ 2)。 */
export function tokens(text: string): Set<string> {
  const s = norm(text)
  const out = new Set<string>()
  for (const m of s.matchAll(/[a-z0-9][a-z0-9._-]*[a-z0-9]|[a-z0-9]{2,}/g)) if (!STOP_WORDS.has(m[0])) out.add(m[0])
  for (const run of s.match(/[一-鿿]+/g) ?? []) {
    for (let i = 0; i + 1 < run.length; i++) { const b = run.slice(i, i + 2); if (!STOP_BIGRAMS.has(b)) out.add(b) }
  }
  // 「166.88.197.165」「v0.5.18」这类也拆开:说「166」要撞得上
  for (const t of [...out]) if (/[._-]/.test(t)) for (const p of t.split(/[._-]+/)) if (p.length >= 2 && !STOP_WORDS.has(p)) out.add(p)
  return out
}

/** 去掉标点 / 空白后够长,而且有几个不同的非停用词,才值得做零候选语义兜底。 */
export function isSubstantiveTopicQuery(text: string): boolean {
  const content = norm(text).replace(/[^\p{L}\p{N}]/gu, '')
  return [...content].length >= TOPIC_FALLBACK_MIN_CHARS && tokens(text).size >= TOPIC_FALLBACK_MIN_TOKENS
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 一个别名 / 标题是否原样出现在这句话里。 */
export function keyIn(key: string, text: string): boolean {
  const k = norm(key).replace(/[「」『』《》]/g, '').trim()
  if (!k) return false
  const t = norm(text)
  const cjk = /[一-鿿]/.test(k)
  if (cjk) return [...k].length >= 2 && t.includes(k)
  if (k.length < 2) return false
  // 英文 / 数字:词边界(「bx」不撞「inbox」);两端是中文也算边界
  return new RegExp(`(^|[^a-z0-9])${escapeRe(k)}($|[^a-z0-9])`).test(t)
}

function topicTokens(t: MatchTopic): Map<string, number> {
  // 标题 / 别名的词更重要(权重 2),摘要和条目行权重 1
  const w = new Map<string, number>()
  const add = (s: string, weight: number) => { for (const tok of tokens(s)) w.set(tok, Math.max(w.get(tok) ?? 0, weight)) }
  add(t.summary, 1)
  for (const e of t.entries) add(e.line, 1)
  add(t.title, 2)
  for (const a of t.aliases) add(a, 2)
  return w
}

export function matchTopics(text: string, topics: readonly MatchTopic[]): TopicMatch {
  const exact: Array<{ id: string; score: number; via: 'exact' }> = []
  for (const t of topics) {
    const keys = [t.title, ...t.aliases]
    const hit = keys.filter(k => keyIn(k, text))
    if (hit.length > 0) exact.push({ id: t.id, score: 100 + Math.max(...hit.map(k => [...k].length)), via: 'exact' })
  }
  if (exact.length > 0) return { hits: exact.sort((a, b) => b.score - a.score).slice(0, MAX_TOPICS), ambiguous: [] }

  const q = tokens(text)
  if (q.size === 0) return { hits: [], ambiguous: [] }
  const scored = topics.map(t => {
    const w = topicTokens(t)
    let score = 0, distinct = 0
    for (const tok of q) { const x = w.get(tok) ?? 0; score += x; if (x > 0) distinct++ }
    return { id: t.id, score, distinct }
  }).filter(s => s.score >= NEAR_MIN).sort((a, b) => b.score - a.score)
  if (scored.length === 0) return { hits: [], ambiguous: [] }
  const [top, second] = scored
  if (top!.score >= NEAR_ACCEPT && (!second || top!.score >= second.score * NEAR_MARGIN)) {
    return { hits: [{ id: top!.id, score: top!.score, via: 'near' }], ambiguous: [] }
  }
  // 只有一个话题沾边、而且撞上了两个不同的词 ⇒ 也算碰到。生产的便宜模型回一个编号要 1–3 秒(真库副本上量过),
  // 只在两个以上候选分不开时才去问它。
  if (!second && top!.distinct >= 2) return { hits: [{ id: top!.id, score: top!.score, via: 'near' }], ambiguous: [] }
  return { hits: [], ambiguous: scored.slice(0, MAX_CANDIDATES).map(({ id, score }) => ({ id, score })) }
}

/** 分不开 / 零候选共用的快判提示词:话题或话题.条目,0 = 都不是。 */
export function topicJudgePrompt(text: string, candidates: readonly MatchTopic[]): string {
  // 不能只按字面相关度挑三条:换说法时,真正相关的旧条目可能没有一个词重合。
  const list = candidates.map((t, i) => {
    const head = `${i + 1}. ${t.title.slice(0, 80)}${t.aliases.length ? `(也叫:${t.aliases.slice(0, 6).map(a => a.slice(0, 40)).join('、')})` : ''} —— ${t.summary.slice(0, 160)}`
    const ents = t.entries.slice(0, TOPIC_JUDGE_MAX_ENTRIES).map((e, j) => `   ${i + 1}.${j + 1} ${e.line.slice(0, TOPIC_JUDGE_ENTRY_CHARS)}`)
    return [head, ...ents].join('\n')
  }).join('\n')
  return `主人对 CC 说了一句话。判断这句话在聊下面哪个话题(以前聊过的),即使换了说法也按意思判断。\n只回一个编号:话题编号(如 2);若对应某条条目,回 话题编号.条目编号(如 2.3)。不在聊其中任何一个(闲聊、新话题)或拿不准就回 0。不要解释或加其他文字。\n\n话题:\n${list}\n\n主人的话:「${text.slice(0, 500)}」\n\n编号:`
}

export interface TopicJudgeSelection { topicId: string; entryId?: string }

/** 整串严格为话题 / 话题.条目才算数;条目超出展示范围时只认话题。 */
export function parseTopicJudge(answer: string, candidates: readonly Pick<MatchTopic, 'id' | 'entries'>[]): TopicJudgeSelection | null {
  const match = answer.trim().match(/^(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/)
  if (!match) return null
  const n = Number(match[1])
  if (n < 1 || n > candidates.length) return null
  const topic = candidates[n - 1]!
  const entryN = match[2] === undefined ? 0 : Number(match[2])
  const entry = entryN >= 1 && entryN <= TOPIC_JUDGE_MAX_ENTRIES ? topic.entries[entryN - 1] : undefined
  return { topicId: topic.id, ...(entry ? { entryId: entry.id } : {}) }
}

const KIND_LABEL: Record<TopicEntryKind, string> = { fact: '事实', decision: '决定', commitment: '承诺', progress: '进展', conclusion: '结论' }

/** 没有独立 unfinished 字段;只把明确写着欠项的 live progress 提前,不把已完成成果当待办。 */
function entryPriority(e: MatchEntry): number {
  if (e.kind === 'commitment') return 5
  const unfinished = `${e.line}\n${e.body}`.split(/[\n;；,，。]/).some(clause => {
    // “已完成全部待办” is completed progress; “已完成桌面;仍待手机验收” still has an obligation.
    if (/(?:已完成|已解决|已处理|已兑现|验收通过|已上线|已交付|\b(?:completed|resolved|finished)\b)/i.test(clause) && !/尚未|未完成|仍|还|但|\b(?:still|remaining|but|not yet)\b/i.test(clause)) return false
    return /尚未|未完成|尚待|仍需|还需|(?:^|\s)待|待(?:补|验收|确认|处理|办|完成|定)|欠|卡在|阻塞|等待|\b(?:pending|blocked|incomplete|remaining|not yet)\b/i.test(clause)
  })
  if (e.kind === 'progress' && unfinished) return 4
  return e.kind === 'decision' ? 3 : e.kind === 'conclusion' ? 2 : e.kind === 'progress' ? 1 : 0
}

/** 模型点名 / 明确相关度优先;同等相关按承诺、未完成进展、决定、结论、一般进展、新近。开场注入直接按优先级。 */
export function pickEntries(text: string, t: MatchTopic, max = MAX_ENTRIES, preferredEntryId?: string, ongoingFirst = false): MatchEntry[] {
  const q = tokens(text)
  const overlap = (e: MatchEntry) => { let n = 0; for (const tok of tokens(`${e.line} ${e.body}`)) if (q.has(tok)) n++; return n }
  return t.entries
    .filter(e => !isRoutineTopicEntry(e))
    .map(e => ({ e, o: overlap(e) }))
    .sort((a, b) => Number(b.e.id === preferredEntryId) - Number(a.e.id === preferredEntryId) || (ongoingFirst ? entryPriority(b.e) - entryPriority(a.e) : 0) || b.o - a.o || entryPriority(b.e) - entryPriority(a.e) || (a.e.updatedTs < b.e.updatedTs ? 1 : a.e.updatedTs > b.e.updatedTs ? -1 : 0))
    .slice(0, max)
    .map(x => x.e)
}

/**
 * 信封里 `<topics>` 的正文(不含标签本身)。最相关的两条带细节;`bodies: false` ⇒ 只有索引行
 * (交给执行者的简报:细节里常有账号、地址这类,执行者用不着 —— 整合者 2026-11-05 第 2 条)。
 */
export function renderTopicsBlock(text: string, picked: readonly MatchTopic[], max = BLOCK_MAX, opts: { bodies?: boolean; preferredEntryIds?: ReadonlyMap<string, string>; ongoingFirst?: boolean } = {}): string {
  const bodies = opts.bodies ?? true
  const parts: string[] = []
  for (const raw of picked) {
    const t = withoutRoutineTopicNoise(raw)
    const es = pickEntries(text, t, MAX_ENTRIES, opts.preferredEntryIds?.get(t.id), opts.ongoingFirst)
    const lines = es.map((e, i) => {
      const body = bodies && i < 2 && e.body ? `:${e.body.slice(0, 160)}` : ''
      return `- [${KIND_LABEL[e.kind] ?? e.kind}] ${e.line}${e.due ? `(期限 ${e.due})` : ''}${body}`
    })
    parts.push([`话题「${t.title}」${t.summary ? `—— ${t.summary}` : ''}`, ...lines].join('\n'))
  }
  const out = parts.join('\n\n')
  return [...out].length > max ? [...out].slice(0, max).join('') + '…' : out
}

export interface TopicSearchHit {
  id: string
  title: string
  summary: string
  score: number
  entries: Array<{ id: string; kind: TopicEntryKind; line: string; body: string; due: string | null }>
}

/**
 * topic_search 工具(主模型自己搜,话题 T2 后续 ①):按相关度排,不设门槛 —— 搜的人自己判断。
 * 词表比每轮匹配宽:条目的细节也算,查询按空格切开的每一段原样出现也算(「Meet」「UDP」)。
 */
export function searchTopics(query: string, topics: readonly MatchTopic[], limit = 3, entriesPer = MAX_ENTRIES): TopicSearchHit[] {
  topics = topics.map(withoutRoutineTopicNoise).filter(t => t.entries.length > 0 || t.summary)
  const q = tokens(query)
  const parts = norm(query).split(/[\s,，、;；]+/).map(p => p.trim()).filter(p => [...p].length >= 2)
  const hits = topics.map(t => {
    let score = 0
    if ([t.title, ...t.aliases].some(k => keyIn(k, query))) score += 10
    const w = topicTokens(t)
    for (const e of t.entries) for (const tok of tokens(e.body)) if (!w.has(tok)) w.set(tok, 0.5)
    for (const tok of q) score += w.get(tok) ?? 0
    const hay = norm([t.title, t.summary, ...t.aliases, ...t.entries.flatMap(e => [e.line, e.body])].join('\n'))
    for (const p of parts) if (hay.includes(p)) score += 1
    return { t, score }
  }).filter(h => h.score > 0).sort((a, b) => b.score - a.score).slice(0, limit)
  return hits.map(({ t, score }) => ({
    id: t.id, title: t.title, summary: t.summary, score: Math.round(score * 10) / 10,
    entries: pickEntries(query, t, entriesPer).map(e => ({ id: e.id, kind: e.kind, line: e.line, body: e.body, due: e.due })),
  }))
}
