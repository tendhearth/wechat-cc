/**
 * 这一轮碰到哪个话题(话题 T2,设计稿 docs/superpowers/specs/2026-11-05-topics-t1-t3-design.md §T2)—— 纯函数,零 I/O。
 *
 *  1. 精确:标题 / 别名原样出现在这句话里(英文按词边界、不分大小写;中文至少 2 个字)⇒ 碰到;
 *  2. 近似:中文二字词 + 英文词,和「标题 + 别名 + 摘要 + 条目索引行」比重合;够多且明显高过第二名 ⇒ 碰到;
 *  3. 拿不准:交出候选(≤ 5),调用方去问便宜模型。一点都不沾 ⇒ 什么都不交,不叫模型。
 * 选好话题以后,每个话题挑几条最相关的条目、渲染成信封里的 `<topics>` 那一段。
 */

export type TopicEntryKind = 'fact' | 'decision' | 'commitment' | 'progress' | 'conclusion'

export interface MatchEntry { id: string; kind: TopicEntryKind; line: string; body: string; due: string | null; updatedTs: string }
export interface MatchTopic { id: string; title: string; summary: string; aliases: string[]; tags: string[]; lastActive: string; entries: MatchEntry[] }

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

/** 拿不准时给便宜模型的提示词:只回一个编号,0 = 都不是。 */
export function topicJudgePrompt(text: string, candidates: readonly MatchTopic[]): string {
  // 带上几条条目索引:主人换个说法时,常常说的是条目里的那件事(「开会卡」↔「Meet 卡顿根因」),不是话题名
  const list = candidates.map((t, i) => {
    const head = `${i + 1}. ${t.title}${t.aliases.length ? `(也叫:${t.aliases.slice(0, 6).join('、')})` : ''} —— ${t.summary}`
    const ents = pickEntries(text, t, 3).map(e => `   · ${e.line.slice(0, 80)}`)
    return [head, ...ents].join('\n')
  }).join('\n')
  return `主人对 CC 说了一句话。判断这句话在聊下面哪个话题(以前聊过的)。\n只回一个数字:话题编号;不在聊其中任何一个(闲聊、新话题)就回 0。拿不准就回 0。\n\n话题:\n${list}\n\n主人的话:「${text.slice(0, 500)}」\n\n数字:`
}

/** 读便宜模型的回答:单独一个数字才算数。 */
export function parseTopicJudge(answer: string, candidates: readonly { id: string }[]): string | null {
  const nums = answer.trim().match(/\d+/g) ?? []
  if (nums.length !== 1) return null
  const n = Number(nums[0])
  return n >= 1 && n <= candidates.length ? candidates[n - 1]!.id : null
}

const KIND_LABEL: Record<TopicEntryKind, string> = { fact: '事实', decision: '决定', commitment: '承诺', progress: '进展', conclusion: '结论' }

/** 一个话题里挑几条:先和这句话重合多的,再还没兑现的承诺,再新近。 */
export function pickEntries(text: string, t: MatchTopic, max = MAX_ENTRIES): MatchEntry[] {
  const q = tokens(text)
  const overlap = (e: MatchEntry) => { let n = 0; for (const tok of tokens(`${e.line} ${e.body}`)) if (q.has(tok)) n++; return n }
  return t.entries
    .map(e => ({ e, o: overlap(e) }))
    .sort((a, b) => b.o - a.o || Number(b.e.kind === 'commitment') - Number(a.e.kind === 'commitment') || (a.e.updatedTs < b.e.updatedTs ? 1 : a.e.updatedTs > b.e.updatedTs ? -1 : 0))
    .slice(0, max)
    .map(x => x.e)
}

/** 信封里 `<topics>` 的正文(不含标签本身)。最相关的两条带细节。 */
export function renderTopicsBlock(text: string, picked: readonly MatchTopic[], max = BLOCK_MAX): string {
  const parts: string[] = []
  for (const t of picked) {
    const es = pickEntries(text, t)
    const lines = es.map((e, i) => {
      const body = i < 2 && e.body ? `:${e.body.slice(0, 160)}` : ''
      return `- [${KIND_LABEL[e.kind] ?? e.kind}] ${e.line}${e.due ? `(期限 ${e.due})` : ''}${body}`
    })
    parts.push([`话题「${t.title}」${t.summary ? `—— ${t.summary}` : ''}`, ...lines].join('\n'))
  }
  const out = parts.join('\n\n')
  return [...out].length > max ? [...out].slice(0, max).join('') + '…' : out
}
