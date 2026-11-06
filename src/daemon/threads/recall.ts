/**
 * 每一轮按话题调记忆(话题 T2,设计稿 docs/superpowers/specs/2026-11-05-topics-t1-t3-design.md §T2)。
 *
 * `resolveTopicRecall`:给一句话和一份话题(带条目),先索引匹配(domain/topic-match),拿不准才问便宜模型;
 * 评测(eval 的 topic 类)用同一个函数跑样本自带的话题。
 * `makeTopicRecall`:生产那一份 —— 只在主人自己的对话里,从库里读话题。失败一律当没碰到,绝不拖垮这一轮。
 */
import type { ThreadsStore, TopicEntry, ThreadRecord } from '../../lib/threads-store'
import { matchTopics, parseTopicJudge, pickEntries, renderTopicsBlock, searchTopics, topicJudgePrompt, MAX_TOPICS, type MatchTopic, type TopicSearchHit } from '../../domain/topic-match'

/** 真库副本上量过:生产的便宜模型(DeepSeek → 想光了换 Qwen)回一个编号 1–3.2 秒。整轮还有 mw-recall 的 4 秒总上限。 */
export const TOPIC_JUDGE_TIMEOUT_MS = 3500
export const TOPIC_RECALL_MIN_CHARS = 2

export interface TopicRecallResult {
  /** 信封里 `<topics>` 的正文。 */
  block: string
  topicIds: string[]
  /** 每个话题挑进来的条目 id(评测按它判)。 */
  entryIds: string[]
  /** 只在调用方真正采用结果后调用;超时迟到的候选没有副作用。 */
  adopt?: (requestId: string, messageIds?: string[]) => void
  via: 'exact' | 'near' | 'model'
}

export interface ResolveOpts {
  /** 拿不准时问的便宜模型;没有 ⇒ 拿不准就当没碰到。 */
  cheapEval?: ((prompt: string) => Promise<string>) | null
  timeoutMs?: number
  log?: (tag: string, line: string) => void
  /** false ⇒ 只放索引行、不带细节(交给执行者的简报)。缺省带。 */
  bodies?: boolean
}

async function judge(text: string, cands: MatchTopic[], o: ResolveOpts): Promise<string | null> {
  if (!o.cheapEval || cands.length === 0) return null
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const answer = await Promise.race([
      o.cheapEval(topicJudgePrompt(text, cands)),
      new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('topic_judge_timeout')), o.timeoutMs ?? TOPIC_JUDGE_TIMEOUT_MS) }),
    ])
    // 空输出 / 想光了(EvalOutputExhaustedError 抛到下面的 catch)⇒ 当没碰到;这一轮不重试,不拖时间
    return answer && answer.trim() ? parseTopicJudge(answer, cands) : null
  } catch (err) {
    o.log?.('TOPICS', `judge skipped: ${err instanceof Error ? err.message : String(err)}`)
    return null
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export async function resolveTopicRecall(text: string, topics: readonly MatchTopic[], o: ResolveOpts = {}): Promise<TopicRecallResult | null> {
  if (text.trim().length < TOPIC_RECALL_MIN_CHARS || topics.length === 0) return null
  const m = matchTopics(text, topics)
  let ids = m.hits.map(h => h.id)
  let via: TopicRecallResult['via'] = m.hits[0]?.via ?? 'model'
  if (ids.length === 0 && m.ambiguous.length > 0) {
    const cands = m.ambiguous.map(a => topics.find(t => t.id === a.id)!).filter(Boolean)
    const picked = await judge(text, cands, o)
    if (picked) { ids = [picked]; via = 'model' }
  }
  if (ids.length === 0) return null
  const picked = ids.slice(0, MAX_TOPICS).map(id => topics.find(t => t.id === id)!).filter(t => t && (t.entries.length > 0 || t.summary))
  if (picked.length === 0) return null
  const block = renderTopicsBlock(text, picked, undefined, { bodies: o.bodies ?? true })
  // 渲染里挑了哪几条,跟 renderTopicsBlock 用同一个挑法
  const entryIds = picked.flatMap(t => pickEntries(text, t).map(e => e.id))
  return { block, topicIds: picked.map(t => t.id), entryIds, via }
}

export function toMatchTopic(t: ThreadRecord, entries: readonly TopicEntry[]): MatchTopic {
  return {
    id: t.id, title: t.title, summary: t.summary, aliases: t.aliases, tags: t.tags, lastActive: t.lastActive,
    entries: entries.filter(e => e.status === 'live').map(e => ({ id: e.id, kind: e.kind, line: e.line, body: e.body, due: e.due, updatedTs: e.updatedTs })),
  }
}

/** 一个对话里还开着的话题(标 done 的不调),带还算数的条目。 */
export async function loadMatchTopics(threads: ThreadsStore, chatId: string): Promise<MatchTopic[]> {
  const [list, entries] = await Promise.all([threads.list(chatId), threads.entriesByThread(chatId, { live: true })])
  return list.filter(t => t.status !== 'done').map(t => toMatchTopic(t, entries.get(t.id) ?? []))
}

export interface TopicRecallDeps {
  onAdopt?: (chatId: string, requestId: string, result: TopicRecallResult, messageIds: string[]) => void
  threads: ThreadsStore
  /** 主人自己的对话才调(现问:配置改了不用重启)。 */
  isOwner: (chatId: string) => boolean
  /** 现取生产的便宜模型(registry.getCheapEval);没有 ⇒ 只用索引。 */
  cheapEval: () => ((prompt: string) => Promise<string>) | null
  timeoutMs?: number
  log: (tag: string, line: string) => void
}

export type TopicRecall = (chatId: string, text: string) => Promise<TopicRecallResult | null>

export function makeTopicRecall(d: TopicRecallDeps): TopicRecall {
  return async (chatId, text) => {
    if (!d.isOwner(chatId)) return null
    try {
      const topics = await loadMatchTopics(d.threads, chatId)
      const r = await resolveTopicRecall(text, topics, { cheapEval: d.cheapEval(), ...(d.timeoutMs !== undefined ? { timeoutMs: d.timeoutMs } : {}), log: d.log })
      if (r) d.log('TOPICS', `recall chat=${chatId} via=${r.via} topics=${r.topicIds.join(',')} entries=${r.entryIds.length} chars=${r.block.length}`)
      if (r && d.onAdopt) r.adopt = (requestId, messageIds = []) => {
        try { if (d.isOwner(chatId)) d.onAdopt!(chatId, requestId, r, messageIds) }
        catch (err) { d.log('TOPICS', `bubble recall failed: ${err instanceof Error ? err.message : String(err)}`) }
      }
      return r
    } catch (err) {
      d.log('TOPICS', `recall failed for ${chatId}: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }
}

/**
 * topic_search 工具的 daemon 一侧(T2 后续 ①):搜的是主人那条对话的话题。私密话题只有从主人自己的对话里搜才给;
 * 档位(admin)由路由管。
 */
export function makeTopicSearch(d: { threads: ThreadsStore; ownerChatId: () => string | null }) {
  return async (callerChatId: string | undefined, query: string, limit = 3): Promise<TopicSearchHit[]> => {
    const owner = d.ownerChatId()
    if (!owner || !query.trim()) return []
    const list = await d.threads.list(owner)
    const hidden = new Set(callerChatId === owner ? [] : list.filter(t => t.private).map(t => t.id))
    const topics = (await loadMatchTopics(d.threads, owner)).filter(t => !hidden.has(t.id))
    return searchTopics(query, topics, Math.min(Math.max(1, limit), 5))
  }
}
