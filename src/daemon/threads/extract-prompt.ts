/**
 * 话题抽取那一次便宜模型调用的纯函数(话题 T1,设计稿 docs/superpowers/specs/2026-11-05-topics-t1-t3-design.md §T1)。
 *
 * buildExtractPrompt  — 拼提示词:已有话题(带条目索引)+ 标签词表 + 近期历史 + 新对话 + agent 做完的活的结论
 * parseExtractResponse — 防御式解析;不合法 ⇒ null(调用方不动水位,下一拍再来)
 *
 * 提示词按 memory.md 吃过的亏写:一条一件事、承诺单独放、推翻旧条目只标不改意思。
 */
// zod v4: `import { z } from 'zod'` resolves to undefined under vitest's
// bundler; use the default export instead.
import z from 'zod'
import type { Facet, Episode, ThreadStatus, EntryKind } from '../../lib/threads-store'

// ── Public types ──────────────────────────────────────────────────────────────

export interface NewEntry { kind: EntryKind; line: string; body?: string; due?: string; /** 结论来自哪件事(agent 的活)。 */ matter?: string }

export type ExtractOp =
  | { op: 'create_topic'; title: string; summary: string; facets: [Facet, ...Facet[]]; tags: string[]; aliases: string[]; private: boolean; episode?: Episode; entries: NewEntry[] }
  | { op: 'update_topic'; id: string; title?: string; summary?: string; facets?: Facet[]; tags?: string[]; aliases?: string[]; private?: boolean; status?: ThreadStatus }
  | { op: 'touch'; id: string; episode: Episode }
  | ({ op: 'add_entry'; topic: string } & NewEntry)
  | { op: 'update_entry'; id: string; line?: string; body?: string; due?: string; status?: 'live' | 'done' | 'superseded' }

// ── Input types ───────────────────────────────────────────────────────────────

export interface PromptMessage { ts: string; direction: 'in' | 'out'; text: string }

export interface PromptTopic {
  id: string
  title: string
  facets: Facet[]
  tags: string[]
  aliases: string[]
  summary: string
  /** 还算数的条目索引(新的在前,已截短)。 */
  entries: Array<{ id: string; kind: EntryKind; line: string; due?: string | null }>
}

export interface PromptWork {
  matterId: string
  title: string
  project: string | null
  state: string
  ask: string | null
  result: string
  at: string
}

export interface ExtractPromptInput {
  newMessages: PromptMessage[]
  existingThreads: PromptTopic[]
  tagVocabulary: string[]
  /** 水位之前的几条,只用来判断话题是不是「又聊到了」,不为它们本身建话题。 */
  contextTail?: PromptMessage[]
  /** agent 做完的活的结论(只在主人的对话上有)。 */
  workResults?: PromptWork[]
}

// ── Constants ─────────────────────────────────────────────────────────────────

export const TEXT_MAX = 500
/** 每个已有话题最多列几条条目索引给模型看(够它判断重复 / 推翻)。 */
export const ENTRIES_PER_TOPIC = 12

const KIND_LABEL: Record<EntryKind, string> = { fact: '事实', decision: '决定', commitment: '承诺', progress: '进展', conclusion: '结论' }

function clip(text: string, n = TEXT_MAX): string {
  return text.length > n ? text.slice(0, n) + '…' : text
}

export function renderMessage(m: PromptMessage): string {
  return `[${m.ts}] ${m.direction === 'in' ? '主人' : 'CC'}: ${clip(m.text)}`
}

export function renderWork(w: PromptWork): string {
  const where = [w.project ? `📁 ${w.project}` : '', w.title].filter(Boolean).join(' · ')
  return [`[${w.at}] 事 ${w.matterId}(${where},${w.state})`, w.ask ? `  要求: ${w.ask}` : '', `  结论: ${w.result}`].filter(Boolean).join('\n')
}

// ── Prompt builder ────────────────────────────────────────────────────────────

const TASK = `你是 CC,在整理和主人聊过的「话题」。话题是记忆的单位,像主人自己的笔记:一个话题一个词(「bx」「服务器」「writter」「妈妈」),
底下一条一条记着跟它有关的事。以后主人一聊到这个话题,CC 只打开这一个话题的那几条。

## 话题
- title:主人嘴里的那个词,≤12 字。不要写成句子(×「bx网络工具的产品架构与核心功能开发」→ ✓「bx」)。
  已有话题的标题超过 12 字、或带「」书名号的,这一批就用 update_topic 把它改成一个词(id 不变),顺手补上 aliases。
- summary:一行索引钩子,≤60 字,说清这个话题是什么、现在大致到哪。
- aliases:主人还会怎么叫它(简称、英文名、口头说法、只属于它的专有名词),3–8 个。以后靠它们认出「又聊到这个了」。
  不要放好几个话题都沾边的大类词(「产品开发」「AI」「运维」)——那是 tags 的事。
- tags:跨话题的大类(「产品开发」「服务器」「家人」),优先复用词表,每个话题 ≤3 个。
- facets:task(在推进的事)/ knowledge(了解、研究过的)/ life(生活、情绪、人)。可多选。
- private:涉及情绪、私人生活、人际关系 ⇒ true;工作 / 技术 ⇒ false。
- 什么时候建:有一条值得以后想起来的事,而且它属于一个以后还会聊到的东西(一个项目、一台机器、一个人、一件持续的事),就建。
  寒暄、一次性的问答、只在这一句里出现的东西不建。先看已有话题能不能放下,放得下就别建新的;两个已有话题其实是一件事,把新条目都记到其中一个。

## 条目(最重要)
- 一条只写一件事:一个配置一条、一个决定一条、一个结果一条。一句话里有两件事就拆成两条。
- line:索引那一行,≤60 字,带上以后会被搜到的关键词(名字、地址、版本、数字)。body:需要时补细节,≤300 字,可省略。
- kind:fact(事实、配置、地址、状态)/ decision(定了什么、为什么)/ commitment(谁答应了谁什么)/ progress(做到哪一步)/ conclusion(一件活的结论)。
- 承诺单独一条 kind=commitment,有日期写 due(YYYY-MM-DD);兑现了用 update_entry 把它标 done,不要新建。
- 新说法推翻了旧条目:旧的 update_entry 标 superseded,再 add_entry 新的;不要在旧条目上改意思。补充细节才直接改旧条目。
- 只记以后还用得上的:结论、决定、配置、约定、卡在哪。日常流水(哪个提交、CI 修了哪个测试、版本号一路往上)不记,
  除非它就是这件事的结论。同一件事有了新进展,用 update_entry 改旧的那条 progress,不要一路堆新的。
- 已经记过的事不要重复记(看已有话题下的条目)。
- 不记密码、密钥、令牌原文;写「密码在 X 处」。
- agent 的活只记结论(改了什么、结果是什么、卡在哪、下一步),不记过程;结论条目写 "matter":"事的编号"。

## 时间戳
episode 的时间戳原样复制消息里的 ts(UTC、以 Z 结尾)。没有对话、只有 agent 的活时不写 episode。

## 输出
只输出一个 JSON 对象 {"ops":[...]},不要 markdown、解释。没有可做的就输出 {"ops":[]}。
- {"op":"create_topic","title":"bx","summary":"…","facets":["task"],"tags":["产品开发"],"aliases":["bx server","代理"],"private":false,"episode":{"from_ts":"…","to_ts":"…"},"entries":[{"kind":"decision","line":"…","body":"…"}]}
- {"op":"update_topic","id":"thr_xxx","title":"…","summary":"…","aliases":["…"]}(只写要改的字段;status 可为 active / dormant / done)
- {"op":"touch","id":"thr_xxx","episode":{"from_ts":"…","to_ts":"…"}}(话题又聊到了)
- {"op":"add_entry","topic":"thr_xxx","kind":"commitment","line":"…","due":"2026-11-20"}
- {"op":"update_entry","id":"ent_xxx","status":"done"}`

export function buildExtractPrompt(input: ExtractPromptInput): string {
  const { newMessages, existingThreads, tagVocabulary, contextTail, workResults } = input

  const topics = existingThreads.length === 0 ? '(暂无)' : existingThreads.map(t => {
    const head = `- id: ${t.id}  「${t.title}」  facets: [${t.facets.join(', ')}]  tags: [${t.tags.join(', ')}]  aliases: [${t.aliases.join(', ')}]${t.summary ? `\n  摘要: ${t.summary}` : ''}`
    const ents = t.entries.slice(0, ENTRIES_PER_TOPIC).map(e => `  · ${e.id} [${KIND_LABEL[e.kind] ?? e.kind}] ${e.line}${e.due ? `(期限 ${e.due})` : ''}`)
    return [head, ...ents].join('\n')
  }).join('\n')

  const vocab = tagVocabulary.length > 0 ? tagVocabulary.join('、') : '(暂无)'
  const tail = contextTail && contextTail.length > 0
    ? `\n=== 近期历史(只用来判断话题是不是又聊到了,不要为它们本身记条目) ===\n${contextTail.map(renderMessage).join('\n')}\n`
    : ''
  const msgs = newMessages.length === 0 ? '(无新消息)' : newMessages.map(renderMessage).join('\n')
  const work = workResults && workResults.length > 0
    ? `\n=== agent 做完的活(只记结论) ===\n${workResults.map(renderWork).join('\n')}\n`
    : ''

  return `${TASK}

=== 已有话题(· 后面是还算数的条目) ===
${topics}

=== 已有 tag 词表(优先复用) ===
${vocab}
${tail}
=== 新增对话片段 ===
${msgs}
${work}
现在返回 JSON。`
}

// ── Zod schema ────────────────────────────────────────────────────────────────

const FacetEnum = z.enum(['task', 'knowledge', 'life'])
/** Require UTC ISO 8601 with Z suffix so lexicographic comparison against db timestamps is stable. */
const UtcIsoString = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/)
const EpisodeSchema = z.object({ from_ts: UtcIsoString, to_ts: UtcIsoString })
const ThreadStatusEnum = z.enum(['active', 'dormant', 'done'])
const KindEnum = z.enum(['fact', 'decision', 'commitment', 'progress', 'conclusion'])
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const Line = z.string().trim().min(1)
const Words = z.array(z.string().trim().min(1))

const EntryShape = { kind: KindEnum, line: Line, body: z.string().optional(), due: Day.optional(), matter: z.string().optional() }

const ExtractOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('create_topic'), title: Line, summary: z.string(), facets: z.array(FacetEnum).min(1), tags: Words, aliases: Words.default([]),
    private: z.boolean(), episode: EpisodeSchema.optional(), entries: z.array(z.object(EntryShape)).default([]),
  }),
  z.object({
    op: z.literal('update_topic'), id: z.string(), title: Line.optional(), summary: z.string().optional(), facets: z.array(FacetEnum).min(1).optional(),
    tags: Words.optional(), aliases: Words.optional(), private: z.boolean().optional(), status: ThreadStatusEnum.optional(),
  }),
  z.object({ op: z.literal('touch'), id: z.string(), episode: EpisodeSchema }),
  z.object({ op: z.literal('add_entry'), topic: z.string(), ...EntryShape }),
  z.object({ op: z.literal('update_entry'), id: z.string(), line: Line.optional(), body: z.string().optional(), due: Day.optional(), status: z.enum(['live', 'done', 'superseded']).optional() }),
])

const ExtractResponseSchema = z.object({ ops: z.array(z.unknown()) })

// ── Response parser ───────────────────────────────────────────────────────────

/**
 * 整体不是 {"ops":[…]} ⇒ null(不动水位)。单条 op 不合法 ⇒ 只丢那一条(`dropped` 计数),别的照做 ——
 * 一批里几十条,一条字段写错就整批作废、水位永远卡住,比丢一条更糟。
 */
export function parseExtractResponse(raw: string): { ops: ExtractOp[]; dropped: number } | null {
  if (!raw || typeof raw !== 'string') return null
  let text = raw.trim()
  text = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '')
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let parsed: unknown
  try { parsed = JSON.parse(text.slice(start, end + 1)) } catch { return null }
  const top = ExtractResponseSchema.safeParse(parsed)
  if (!top.success) return null
  const ops: ExtractOp[] = []
  let dropped = 0
  for (const o of top.data.ops) {
    const r = ExtractOpSchema.safeParse(o)
    if (r.success) ops.push(r.data as ExtractOp); else dropped++
  }
  return { ops, dropped }
}
