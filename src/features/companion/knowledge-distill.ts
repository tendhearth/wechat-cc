/**
 * Distill the Knowledge Kernel's computed knowledge into a concise markdown
 * digest for the owner's always-on `knowledge.md` (knowledge-distillation
 * design, D1). This is the WRITE-side bridge between the in-process
 * Knowledge Kernel (src/core/knowledge) and the daemon's always-injected
 * memory — the objective counterpart to the agent's subjective profile.md.
 * Deterministic (no LLM): the kernel outputs are already structured, so we
 * just format them. Every source is guarded — a missing/failed one drops
 * its subsection; all-empty ⇒ '' (⇒ caller writes nothing / omits the
 * section).
 *
 * v1 = the OWNER's global social state (open obligations + key/neglected
 * relationships), so no chatId→contact-name join is needed. `person_brief`
 * remains the on-demand deep-dive for a specific contact.
 *
 * Formerly bridged to the retired wxfacts/wxgraph MCP plugins via JSON-RPC
 * (`DistillBridge`/`parseCall`); now calls the in-proc `FactsApi`/
 * `GraphQueryApi` directly — synchronous, no JSON (de)serialization.
 */
import type { FactsApi } from '../../core/knowledge/facts'
import type { GraphQueryApi } from '../../core/knowledge/graph-query'
import type { Contact } from '../../core/knowledge/graph'

export interface DistillKnowledge {
  facts?: FactsApi
  graph?: GraphQueryApi
}

export const KNOWLEDGE_DISTILL_CAP = 1500

const safe = <T>(fn: () => T, dflt: T): T => {
  try { return fn() } catch { return dflt }
}

/** Display names from a `topContacts` result (already-typed `Contact[]`). */
function contactNames(list: unknown, limit: number): string[] {
  if (!Array.isArray(list)) return []
  const out: string[] = []
  for (const c of list as Contact[]) {
    const name = (c?.display || c?.username) as string | undefined
    if (name) out.push(name)
    if (out.length >= limit) break
  }
  return out
}

export async function distillOwnerKnowledge(knowledge: DistillKnowledge | undefined): Promise<string> {
  const parts: string[] = []

  // Open obligations. value/predicate carry the description; we skip
  // the raw wxid contact to avoid ugly ids in v1.
  if (knowledge?.facts) {
    const res = safe(() => knowledge.facts!.findFacts('obligation', null, null, 'active', 20) as { results?: unknown[] }, null)
    const results = Array.isArray(res?.results) ? res!.results : []
    const lines: string[] = []
    for (const r of results.slice(0, 12)) {
      if (r && typeof r === 'object') {
        const rec = r as Record<string, unknown>
        const text = `${typeof rec.predicate === 'string' ? rec.predicate : ''} ${typeof rec.value === 'string' ? rec.value : ''}`.trim()
        if (text) lines.push(`- ${text}`)
      }
    }
    if (lines.length) parts.push(`**未了义务**\n${lines.join('\n')}`)
  }

  // Key + neglected relationships.
  if (knowledge?.graph) {
    const close = contactNames(safe(() => knowledge.graph!.topContacts('closeness', 5, 'person'), []), 5)
    if (close.length) parts.push(`**亲近的人**\n- ${close.join('、')}`)
    const neglected = contactNames(safe(() => knowledge.graph!.topContacts('neglected', 5, 'person'), []), 5)
    if (neglected.length) parts.push(`**好久没联系**\n- ${neglected.join('、')}`)
  }

  if (parts.length === 0) return ''
  const body = `## 你的社交状态（算出来的，非主观）\n\n${parts.join('\n\n')}`
  return body.length > KNOWLEDGE_DISTILL_CAP ? body.slice(0, KNOWLEDGE_DISTILL_CAP) : body
}
