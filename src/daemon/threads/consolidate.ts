/**
 * 睡一觉时整理话题(设计稿 docs/superpowers/specs/2026-11-05-topics-t1-t3-design.md「后续 ④」)。
 *
 * 每晚整理记忆真跑过一次之后,接着整理这次以来改过的话题:同一件事一路记下来的几条进展并成一条(模型只分组、代码核主题词),
 * 几乎一样的事实并成一条(代码判);并出来的那条用最新那条的原话。被并掉的旧条目标 superseded、superseded_by 指向新的那条(不删)。
 * 承诺、决定、结论不并。提交号按规则去掉。话题摘要由代码从还算数的条目拼。
 * 失败:同一个话题重试一次,还不行跳过它、水位不前移(下一晚再来);网络不安全 ⇒ 整批停。
 */
import z from 'zod'
import type { ThreadsStore, TopicEntry, EntryKind } from '../../lib/threads-store'
import { isNetworkUnprotectedError } from '../../lib/network-gate'
import { tokens } from '../../domain/topic-match'

/** 条目少到这个数以内、又没有提交号 ⇒ 不叫模型。 */
export const CONSOLIDATE_MIN_LIVE = 3

// 「(commit 3897195)」「(e2aa78ba)」「commit fb9cd6f」「8953e4bf..831fb23d」:十六进制、至少带一个数字,7–40 位
const HEX = '(?=[0-9a-f]*\\d)[0-9a-f]{7,40}'
/** 光秃秃放在括号里的,还要至少一个字母(「(12345678)」这种纯数字编号不动)。 */
const HEX_BARE = '(?=[0-9a-f]*\\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}'
const HASH_RES: RegExp[] = [
  new RegExp(`\\s*[（(]\\s*(?:commit|squash)\\s+${HEX}(?:\\.\\.${HEX})?\\s*[)）]`, 'gi'),
  new RegExp(`\\s*[（(]\\s*${HEX_BARE}(?:\\.\\.${HEX})?\\s*[)）]`, 'gi'),
  new RegExp(`\\s*\\b(?:commit|squash)\\s+${HEX}\\b`, 'gi'),
  new RegExp(`\\s*\\b${HEX}\\.\\.${HEX}\\b`, 'gi'),
]

export function hasCommitHash(s: string): boolean {
  return HASH_RES.some(re => { re.lastIndex = 0; return re.test(s) })
}

export function stripCommitHashes(s: string): string {
  let out = s
  for (const re of HASH_RES) out = out.replace(re, '')
  return out.replace(/[ \t]{2,}/g, ' ').replace(/\s+([,，;；。])/g, '$1').trim()
}

/**
 * 只认得出「同一件事」才并(整合者 2026-11-05 第二轮:记错比记乱更糟):
 *  - progress:模型提一组,代码再核 —— 这组里每一条都要和最新那条共享至少 SUBJECT_MIN 个「主题词」
 *    (中文二字词 / 英文词,先去掉话题自己的标题和别名里的词:「1in8b」「Stripe」这种全话题都有的不算)。
 *  - fact:不问模型,代码判几乎一样(词的 Jaccard ≥ FACT_SIMILAR)才并。
 *  - 承诺、决定、结论不并。
 * 并出来的那条:line = 被并的里面**最新**那条的 line(去掉提交号,不是模型改写);较旧的那几条的 line 原样折进细节。
 * 话题摘要也不让模型写:代码拿最新的进展 / 结论那一行 + 最新的决定那一行拼(buildSummary)。
 */
export const SUBJECT_MIN = 2
export const FACT_SIMILAR = 0.8
const BODY_MAX = 600

function subjectTokens(text: string, topicWords: ReadonlySet<string>): Set<string> {
  const out = new Set<string>()
  for (const t of tokens(stripCommitHashes(text))) if (!topicWords.has(t) && !/^\d+$/.test(t)) out.add(t)
  return out
}

export function topicWordsOf(topic: { title: string; aliases?: readonly string[] }): Set<string> {
  return new Set([topic.title, ...(topic.aliases ?? [])].flatMap(k => [...tokens(k)]))
}

/** 这一组是不是同一件事:每一条和最新那条共享至少 SUBJECT_MIN 个主题词。 */
export function sameSubject(group: readonly TopicEntry[], topicWords: ReadonlySet<string>): boolean {
  if (group.length < 2) return false
  const newest = newestOf(group)
  const ref = subjectTokens(newest.line, topicWords)
  return group.every(e => {
    if (e.id === newest.id) return true
    let shared = 0
    for (const t of subjectTokens(e.line, topicWords)) if (ref.has(t)) shared++
    return shared >= SUBJECT_MIN
  })
}

export function similarity(a: string, b: string): number {
  const x = tokens(stripCommitHashes(a)), y = tokens(stripCommitHashes(b))
  if (x.size === 0 && y.size === 0) return 1
  let inter = 0
  for (const t of x) if (y.has(t)) inter++
  return inter / (x.size + y.size - inter)
}

function newestOf(group: readonly TopicEntry[]): TopicEntry {
  return [...group].sort((a, b) => (a.updatedTs < b.updatedTs ? 1 : a.updatedTs > b.updatedTs ? -1 : a.id < b.id ? 1 : -1))[0]!
}

/** 并出来的那条:最新那条的 line(去提交号),细节 = 最新那条的细节 + 较旧几条的 line 原样(新到旧)。 */
export function mergedEntry(group: readonly TopicEntry[]): { kind: EntryKind; line: string; body: string; ts: string; source: 'work' | 'chat' } {
  const newest = newestOf(group)
  const older = group.filter(e => e.id !== newest.id).sort((a, b) => (a.updatedTs < b.updatedTs ? 1 : -1))
  const olderPart = `之前:\n${older.map(e => `- ${stripCommitHashes(e.line)}`).join('\n')}`
  const own = stripCommitHashes(newest.body)
  const room = BODY_MAX - olderPart.length - 1
  const body = own && room > 20 ? `${own.slice(0, room)}\n${olderPart}` : olderPart
  return { kind: newest.kind, line: stripCommitHashes(newest.line), body: body.slice(0, BODY_MAX), ts: newest.updatedTs, source: group.every(e => e.source === 'work') ? 'work' : 'chat' }
}

/** 话题摘要(代码拼,不让模型写):最新的进展 / 结论那一行 + 最新的决定那一行;都没有 ⇒ null(不改)。 */
export function buildSummary(live: readonly TopicEntry[]): string | null {
  const pick = (kinds: EntryKind[]) => { const xs = live.filter(e => kinds.includes(e.kind)); return xs.length ? newestOf(xs) : null }
  const parts = [pick(['progress', 'conclusion']), pick(['decision'])].filter((e): e is TopicEntry => !!e).map(e => stripCommitHashes(e.line))
  return parts.length ? parts.join(';') : null
}

/** 几乎一样的事实(代码判,不问模型):按出现先后贪心分组。 */
export function duplicateFactGroups(live: readonly TopicEntry[]): TopicEntry[][] {
  const facts = live.filter(e => e.kind === 'fact')
  const used = new Set<string>()
  const groups: TopicEntry[][] = []
  for (const a of facts) {
    if (used.has(a.id)) continue
    const g = [a, ...facts.filter(b => b.id !== a.id && !used.has(b.id) && similarity(a.line, b.line) >= FACT_SIMILAR)]
    if (g.length > 1) { g.forEach(e => used.add(e.id)); groups.push(g) }
  }
  return groups
}

export function consolidatePrompt(topic: { title: string; summary: string }, progress: readonly TopicEntry[]): string {
  const list = progress.map(e => `- ${e.id} ${e.updatedTs.slice(0, 10)} ${e.line}`).join('\n')
  return `你是 CC,今晚在整理话题「${topic.title}」下记的进展。找出**说的是同一件事、只是一路往前推进**的几条(「美洲板块上线」「非洲板块上线」「全部板块上线」是同一件事;
「D-U-N-S 已分配」「Mercury 开了两步验证」「8822-B 签好字」是三件不同的事,不要放一组)。拿不准就别放一组。
只分组,不要改写文字 —— 文字由程序按最新那条留。

## 进展
${list}

## 输出
只输出一个 JSON 对象:{"groups":[["ent_a","ent_b"]]};没有就 {"groups":[]}。每组至少两个 id,一个 id 只能在一组里。`
}

const ResponseSchema = z.object({ groups: z.array(z.array(z.string())) })

/** 读模型的分组;只留这批里的 progress、至少两条、一条只用一次、且代码核过是同一件事的组。整体不成形 ⇒ null。 */
export function parseConsolidate(raw: string, progress: readonly TopicEntry[], topicWords: ReadonlySet<string>): TopicEntry[][] | null {
  if (!raw) return null
  const text = raw.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '')
  const a = text.indexOf('{'), b = text.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  let parsed: unknown
  try { parsed = JSON.parse(text.slice(a, b + 1)) } catch { return null }
  const top = ResponseSchema.safeParse(parsed)
  if (!top.success) return null
  const byId = new Map(progress.filter(e => e.kind === 'progress').map(e => [e.id, e]))
  const used = new Set<string>()
  const out: TopicEntry[][] = []
  for (const g of top.data.groups) {
    const ids = [...new Set(g)]
    if (ids.length < 2 || ids.some(id => !byId.has(id) || used.has(id))) continue
    const group = ids.map(id => byId.get(id)!)
    if (!sameSubject(group, topicWords)) continue
    ids.forEach(id => used.add(id))
    out.push(group)
  }
  return out
}

async function evalOnce(sdkEval: (p: string) => Promise<string>, prompt: string): Promise<string> {
  for (let i = 0; i < 2; i++) {
    try {
      const out = await sdkEval(prompt)
      if (out && out.trim()) return out
    } catch (err) {
      if (isNetworkUnprotectedError(err)) throw err
      if (!(err instanceof Error && (err.name === 'EvalOutputExhaustedError' || err.message.startsWith('eval_output_exhausted')))) throw err
    }
  }
  return ''
}

export interface ConsolidateDeps {
  chatId: string
  threads: ThreadsStore
  sdkEval: ((prompt: string) => Promise<string>) | null
  log: (tag: string, line: string) => void
  now?: () => string
}

export interface ConsolidateResult { topics: number; merged: number; stripped: number; failed: number }

export async function consolidateTopics(d: ConsolidateDeps): Promise<ConsolidateResult> {
  const startedAt = d.now ? d.now() : new Date().toISOString()
  const res: ConsolidateResult = { topics: 0, merged: 0, stripped: 0, failed: 0 }
  const since = (await d.threads.getExtractState(d.chatId)).consolidatedToTs ?? ''
  const [list, byThread] = await Promise.all([d.threads.list(d.chatId), d.threads.entriesByThread(d.chatId)])
  for (const t of list) {
    const all = byThread.get(t.id) ?? []
    if (!(t.lastActive > since || all.some(e => e.updatedTs > since))) continue
    const live = all.filter(e => e.status === 'live')
    if (live.length === 0) continue
    res.topics++
    const topicWords = topicWordsOf(t)
    const groups: TopicEntry[][] = duplicateFactGroups(live)
    // 1) 进展:模型只分组,代码核过才并
    const progress = live.filter(e => e.kind === 'progress')
    if (progress.length >= 2 && live.length > CONSOLIDATE_MIN_LIVE && d.sdkEval) {
      let picked: TopicEntry[][] | null = null
      try {
        picked = parseConsolidate(await evalOnce(d.sdkEval, consolidatePrompt(t, progress)), progress, topicWords)
      } catch (err) {
        if (isNetworkUnprotectedError(err)) { d.log('TOPICS', 'consolidate stopped — network unprotected'); res.failed++; return res }
        d.log('TOPICS', `consolidate ${t.id} failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      if (!picked) { res.failed++; d.log('TOPICS', `consolidate ${t.id}: no usable answer, progress left as is`) }
      else groups.push(...picked)
    }
    for (const g of groups) {
      const m = mergedEntry(g)
      const id = await d.threads.addEntry({ threadId: t.id, kind: m.kind, line: m.line, body: m.body, source: m.source, ts: m.ts })
      for (const e of g) await d.threads.updateEntry(e.id, { status: 'superseded', supersededBy: id, ts: startedAt })
      res.merged += g.length
    }
    // 2) 剩下还算数的:提交号按规则去掉(不叫模型)
    for (const e of await d.threads.entries(t.id, { live: true })) {
      if (!hasCommitHash(e.line) && !hasCommitHash(e.body)) continue
      await d.threads.updateEntry(e.id, { line: stripCommitHashes(e.line), body: stripCommitHashes(e.body), ts: e.updatedTs })
      res.stripped++
    }
    // 3) 摘要:代码拼,不让模型写(模型改写过摘要,把「待邮寄」写成了「已寄出」)
    const summary = buildSummary(await d.threads.entries(t.id, { live: true }))
    if (summary && summary !== t.summary) await d.threads.update(t.id, { summary })
  }
  if (res.failed === 0) await d.threads.setExtractState(d.chatId, { consolidatedToTs: startedAt })
  d.log('TOPICS', `consolidate chat=${d.chatId} topics=${res.topics} merged=${res.merged} stripped=${res.stripped} failed=${res.failed}`)
  return res
}
