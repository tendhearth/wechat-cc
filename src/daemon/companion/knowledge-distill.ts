/**
 * Distill the plugins' computed knowledge into a concise markdown digest for the
 * owner's always-on `knowledge.md` (knowledge-distillation design, D1). This is
 * the WRITE-side bridge between the plugin knowledge stack and the daemon's
 * always-injected memory — the objective counterpart to the agent's subjective
 * profile.md. Deterministic (no LLM): the plugin outputs are already structured,
 * so we just format them. Every source is guarded — a missing/failed one drops
 * its subsection; all-empty ⇒ '' (⇒ caller writes nothing / omits the section).
 *
 * v1 = the OWNER's global social state (open obligations + key/neglected
 * relationships), so no chatId→contact-name join is needed. `person_brief`
 * remains the on-demand deep-dive for a specific contact.
 */
export interface DistillBridge {
  call: (tool: string, input?: unknown) => Promise<string>
  hasTool: (tool: string) => boolean
}

export const KNOWLEDGE_DISTILL_CAP = 1500

async function parseCall(bridge: DistillBridge, tool: string, input: unknown): Promise<unknown> {
  try {
    return JSON.parse(await bridge.call(tool, input))
  } catch {
    return null
  }
}

/** Display names from a wxgraph top_contacts result (a JSON array of contact dicts). */
function contactNames(parsed: unknown, limit: number): string[] {
  if (!Array.isArray(parsed)) return []
  const out: string[] = []
  for (const c of parsed) {
    if (c && typeof c === 'object') {
      const rec = c as Record<string, unknown>
      const name = typeof rec.display === 'string' ? rec.display
        : typeof rec.username === 'string' ? rec.username : null
      if (name) out.push(name)
    }
    if (out.length >= limit) break
  }
  return out
}

export async function distillOwnerKnowledge(bridge: DistillBridge): Promise<string> {
  const parts: string[] = []

  // Open obligations (wxfacts). value/predicate carry the description; we skip
  // the raw wxid contact to avoid ugly ids in v1.
  if (bridge.hasTool('find_facts')) {
    const res = await parseCall(bridge, 'find_facts', { kind: 'obligation', status: 'active', limit: 20 })
    const results = res && typeof res === 'object' && Array.isArray((res as { results?: unknown }).results)
      ? (res as { results: unknown[] }).results : []
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

  // Key + neglected relationships (wxgraph).
  if (bridge.hasTool('top_contacts')) {
    const close = contactNames(await parseCall(bridge, 'top_contacts', { by: 'closeness', limit: 5, kind: 'person' }), 5)
    if (close.length) parts.push(`**亲近的人**\n- ${close.join('、')}`)
    const neglected = contactNames(await parseCall(bridge, 'top_contacts', { by: 'neglected', limit: 5, kind: 'person' }), 5)
    if (neglected.length) parts.push(`**好久没联系**\n- ${neglected.join('、')}`)
  }

  if (parts.length === 0) return ''
  const body = `## 你的社交状态（算出来的，非主观）\n\n${parts.join('\n\n')}`
  return body.length > KNOWLEDGE_DISTILL_CAP ? body.slice(0, KNOWLEDGE_DISTILL_CAP) : body
}
