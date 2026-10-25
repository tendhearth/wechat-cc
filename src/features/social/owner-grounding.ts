/**
 * Owner grounding — in-process fact fetch for the agent-social judge. Given
 * an intent topic, reads the owner's relevant derived facts from the
 * Knowledge Kernel (facts.db substring match + optional semantic message
 * recall) and formats them as grounding text for the judge's prompt.
 *
 * Graceful degrade is the core property: undefined knowledge, empty stores,
 * or ANY sub-fetch throwing all resolve to '' — this must never throw, since
 * a knowledge-kernel hiccup should never block the judge from running (it
 * just runs blind, same as before this slice existed).
 */
import type { KnowledgeStore } from '../../core/knowledge/store'
import type { FactsApi } from '../../core/knowledge/facts'
import type { semanticSearch as SemSearch } from '../../core/knowledge/search'

export interface GroundingKnowledge {
  facts?: FactsApi
  search?: typeof SemSearch
  store?: KnowledgeStore
  embedQuery?: (t: string) => Promise<number[]>
  embedder?: { model_id: string }
}

const FACT_LIMIT = 40
const MSG_LIMIT = 6
const CHAR_CAP = 2000

const safe = async <T>(fn: () => Promise<T> | T, dflt: T): Promise<T> => {
  try { return await fn() } catch { return dflt }
}

export function makeOwnerGrounding(knowledge: GroundingKnowledge | undefined) {
  return async (card: { topic: string; city?: string }): Promise<string> => {
    if (!knowledge) return ''
    const parts: string[] = []

    // 1) structured facts (substring match on topic; always available)
    if (knowledge.facts) {
      const rows = await safe(
        () => knowledge.facts!.findFacts(null, null, card.topic, 'active', FACT_LIMIT) as { results: any[] },
        { results: [] as any[] },
      )
      const lines = (rows?.results ?? []).map((f: any) => `- ${f.predicate}: ${f.value}`)
      if (lines.length) parts.push('主人相关事实：\n' + lines.join('\n'))
    }

    // 2) semantic message recall (only when embedder + search + store present)
    if (knowledge.search && knowledge.store && knowledge.embedQuery && knowledge.embedder) {
      const snippets = await safe(async () => {
        const qv = await knowledge.embedQuery!(card.topic)
        const res = knowledge.search!(knowledge.store!, { queryText: card.topic, queryVector: qv, model_id: knowledge.embedder!.model_id, limit: MSG_LIMIT } as any)
        return (res?.results ?? []).map((r: any) => `- ${(r.text || '').replace(/\s+/g, ' ').slice(0, 80)}`)
      }, [] as string[])
      if (snippets.length) parts.push('主人相关消息：\n' + snippets.join('\n'))
    }

    const text = parts.join('\n\n')
    return text.length > CHAR_CAP ? text.slice(0, CHAR_CAP) : text
  }
}
