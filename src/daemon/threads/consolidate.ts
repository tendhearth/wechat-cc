/**
 * 睡一觉时整理话题(设计稿 docs/superpowers/specs/2026-11-05-topics-t1-t3-design.md「后续 ④」)。
 *
 * 每晚整理记忆真跑过一次之后,接着整理这次以来改过的话题:还算数的条目交给便宜模型,把重复的进展并成一条「现在到哪了」;
 * 被并掉的旧条目标 superseded、superseded_by 指向新的那条(不删)。承诺、决定不并。提交号按规则去掉(模型也被要求去)。
 * 失败:同一个话题重试一次,还不行跳过它、水位不前移(下一晚再来);网络不安全 ⇒ 整批停。
 */
import z from 'zod'
import type { ThreadsStore, TopicEntry, EntryKind } from '../../lib/threads-store'
import { isNetworkUnprotectedError } from '../../lib/network-gate'

/** 条目少到这个数以内、又没有提交号 ⇒ 不叫模型。 */
export const CONSOLIDATE_MIN_LIVE = 3
const MERGEABLE = new Set<EntryKind>(['progress', 'conclusion', 'fact'])

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

const KIND_LABEL: Record<EntryKind, string> = { fact: '事实', decision: '决定', commitment: '承诺', progress: '进展', conclusion: '结论' }

export function consolidatePrompt(topic: { title: string; summary: string }, live: readonly TopicEntry[]): string {
  const list = live.map(e => `- ${e.id} [${KIND_LABEL[e.kind] ?? e.kind}] ${e.line}${e.body ? `\n    细节: ${e.body.slice(0, 200)}` : ''}`).join('\n')
  return `你是 CC,今晚在整理话题「${topic.title}」下记的条目(${topic.summary})。主人以后聊到这个话题,只会看到还算数的这几条。

## 要做的
- 同一件事一路记下来的好几条进展(「上线了 A」「上线了 B」「又上线了 C」),并成一条「现在到哪了」:一行说清现状,细节里按要点列出做过的几步。
- 两条说的是同一个事实,也并成一条。
- **不并**:承诺、决定 —— 它们一条一件事,原样留着。被推翻的旧说法已经不在下面了,不用管。
- 去掉提交号、哈希(「commit 3897195」「(e2aa78ba)」)。版本号、日期、数字照留。
- 不编造,只用下面已有的内容。没有可并的就输出 {"merge":[]}。
- summary:话题的一行钩子(≤ 60 字),说清现在大致到哪;不用改就不写。

## 条目
${list}

## 输出
只输出一个 JSON 对象:{"merge":[{"ids":["ent_a","ent_b"],"kind":"progress","line":"≤60 字","body":"≤300 字,可省略"}],"summary":"…"}
每个 merge 至少两个 id,一个 id 只能出现在一个 merge 里。`
}

const MergeSchema = z.object({ ids: z.array(z.string()).min(2), kind: z.enum(['progress', 'conclusion', 'fact']), line: z.string().trim().min(1), body: z.string().optional() })
const ResponseSchema = z.object({ merge: z.array(z.unknown()), summary: z.string().optional() })

export type ConsolidatePlan = { merge: Array<z.infer<typeof MergeSchema>>; summary?: string }

/** 防御式读;整体不成形 ⇒ null。不合法的那一个 merge 丢掉(id 不在、跨了不能并的种类、重复用同一个 id)。 */
export function parseConsolidate(raw: string, live: readonly TopicEntry[]): ConsolidatePlan | null {
  if (!raw) return null
  const text = raw.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '')
  const a = text.indexOf('{'), b = text.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  let parsed: unknown
  try { parsed = JSON.parse(text.slice(a, b + 1)) } catch { return null }
  const top = ResponseSchema.safeParse(parsed)
  if (!top.success) return null
  const byId = new Map(live.map(e => [e.id, e]))
  const used = new Set<string>()
  const merge: ConsolidatePlan['merge'] = []
  for (const m of top.data.merge) {
    const r = MergeSchema.safeParse(m)
    if (!r.success) continue
    const ids = [...new Set(r.data.ids)]
    if (ids.length < 2 || ids.some(id => !byId.has(id) || used.has(id) || !MERGEABLE.has(byId.get(id)!.kind))) continue
    ids.forEach(id => used.add(id))
    merge.push({ ...r.data, ids })
  }
  const summary = top.data.summary?.trim()
  return { merge, ...(summary ? { summary } : {}) }
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
    // 1) 能并的交给模型
    if (live.length > CONSOLIDATE_MIN_LIVE && d.sdkEval) {
      let plan: ConsolidatePlan | null = null
      try {
        plan = parseConsolidate(await evalOnce(d.sdkEval, consolidatePrompt(t, live)), live)
      } catch (err) {
        if (isNetworkUnprotectedError(err)) { d.log('TOPICS', 'consolidate stopped — network unprotected'); res.failed++; return res }
        d.log('TOPICS', `consolidate ${t.id} failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      if (!plan) { res.failed++; d.log('TOPICS', `consolidate ${t.id}: no usable answer, left as is`) }
      else {
        const byId = new Map(live.map(e => [e.id, e]))
        for (const m of plan.merge) {
          const olds = m.ids.map(id => byId.get(id)!)
          const ts = olds.map(e => e.updatedTs).sort().pop()!
          const id = await d.threads.addEntry({
            threadId: t.id, kind: m.kind, line: stripCommitHashes(m.line), ...(m.body ? { body: stripCommitHashes(m.body) } : {}),
            source: olds.every(e => e.source === 'work') ? 'work' : 'chat', ts,
          })
          for (const e of olds) await d.threads.updateEntry(e.id, { status: 'superseded', supersededBy: id, ts: startedAt })
          res.merged += olds.length
        }
        if (plan.summary) await d.threads.update(t.id, { summary: stripCommitHashes(plan.summary).slice(0, 120) })
      }
    }
    // 2) 剩下还算数的:提交号按规则去掉(不叫模型)
    for (const e of await d.threads.entries(t.id, { live: true })) {
      if (!hasCommitHash(e.line) && !hasCommitHash(e.body)) continue
      await d.threads.updateEntry(e.id, { line: stripCommitHashes(e.line), body: stripCommitHashes(e.body), ts: e.updatedTs })
      res.stripped++
    }
  }
  if (res.failed === 0) await d.threads.setExtractState(d.chatId, { consolidatedToTs: startedAt })
  d.log('TOPICS', `consolidate chat=${d.chatId} topics=${res.topics} merged=${res.merged} stripped=${res.stripped} failed=${res.failed}`)
  return res
}
