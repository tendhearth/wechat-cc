/**
 * Person layer — `makePersonApi(store)`, a stateless Query composite that
 * assembles one contact's unified brief from the in-process graph (GR
 * Task 4/5), facts (Task 2's `makeFactsApi`), and source recent-messages
 * (Task 1's `store.recentMessages`). Faithful port of wxperson's
 * `brief.py`'s `person_brief` — see
 * wechat-cc-plugins/packages/wxperson/wxperson/brief.py.
 *
 * `person_brief` deliberately does NOT read the daemon's .md memory — the
 * daemon already injects the chat's profile as core memory, and the agent
 * composes "its take + this data". Each source is independent and degrades
 * gracefully via `safe()`: a missing/erroring sibling yields a null/[] field,
 * never a crash — this module writes NOTHING (pure read composite).
 */
import type { KnowledgeStore } from './store'
import { resolveName } from './graph'
import { makeGraphQueryApi } from './graph-query'
import { makeFactsApi } from './facts'

const safe = <T>(fn: () => T, dflt: T): T => { try { return fn() } catch { return dflt } }

export interface PersonApi { personBrief(name: string, recentN: number): object }

export function makePersonApi(store: KnowledgeStore): PersonApi {
  const graph = makeGraphQueryApi(store)
  const facts = makeFactsApi(store)
  return {
    personBrief(name, recentN) {
      const { username: un, candidates } = resolveName(store.allContacts(), name)
      if (!un) return { name, resolved: false, candidates }
      const relationship = safe(() => graph.contactProfile(name), null)
      const factsView = safe(() => facts.contactFacts(name), null)
      const obligations = safe(() => {
        const all = (facts.findFacts('obligation', null, null, 'active', 100) as any).results ?? []
        return all.filter((r: any) => r.contact === un || r.related_contact === un || r.related_contact === name)
      }, [])
      const recent_messages = safe(() => store.recentMessages(un, recentN), [])
      return { name, resolved: true, wxid: un, relationship, facts: factsView, obligations, recent_messages }
    },
  }
}
