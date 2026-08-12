/**
 * Facts orchestration — candidate feed, record-and-advance, and fact
 * queries. TS port of wxfacts's `facts.py` (see
 * wechat-cc-plugins/packages/wxfacts/wxfacts/facts.py), adapted to the
 * in-process `KnowledgeStore` (facts.db T1) and the in-process graph slice
 * (`resolveName` from `./graph`) instead of wxfacts's separate
 * wxgraph/graph.sqlite lookup.
 *
 * `local_id` has no dedicated source column (no source schema change) — it
 * is parsed out of `msg_key`, whose format is `"<table>:<local_id>"`: the
 * integer AFTER THE LAST `:` (matches wxfacts/source.py's msg_key parsing).
 */
import type { KnowledgeStore, Fact } from './store'
import { resolveName } from './graph'

const localIdOf = (msgKey: string): number => {
  const i = msgKey.lastIndexOf(':')
  return i < 0 ? 0 : Number(msgKey.slice(i + 1)) || 0
}
const encodeBatchId = (contact: string, ts: number, localId: number) =>
  JSON.stringify({ c: contact, u: ts, l: localId })
const decodeBatchId = (b: string): [string, number, number] => {
  const d = JSON.parse(b); return [d.c, Number(d.u), Number(d.l ?? 0)]
}

export interface FactsApi {
  nextBatch(contact: string | null, limit: number): object
  record(batchId: string, facts: Fact[], now: number): object
  contactFacts(name: string): object
  findFacts(kind: string | null, predicate: string | null, query: string | null, status: string | null, limit: number | null): object
  setFactStatus(id: number, status: string, now: number): object
  extractionStatus(): object
}

export function makeFactsApi(store: KnowledgeStore): FactsApi {
  const displayMap = () => new Map(store.allSourceContacts().map((c) => [c.username, c.display]))
  const grouped = () => {
    const g = new Map<string, Array<{ msg_key: string; conversation: string; sender: string; time: number; text: string; local_id: number }>>()
    for (const m of store.oneToOneTextMessages()) {
      const row = { ...m, local_id: localIdOf(m.msg_key) }
      if (!g.has(m.conversation)) g.set(m.conversation, [])
      g.get(m.conversation)!.push(row)
    }
    for (const rows of g.values())
      rows.sort((x, y) => x.time - y.time || x.local_id - y.local_id)   // total order
    return g
  }
  const resolveContact = (name: string): string => {
    const { username } = resolveName(store.allContacts(), name)
    return username ?? name                                             // fall back to raw (may be a username)
  }
  const backlog = (rows: any[], contact: string) => {
    const [wt, wl] = store.factWatermark(contact)
    return rows.filter((m) => m.time > wt || (m.time === wt && m.local_id > wl))
  }

  return {
    nextBatch(contact, limit) {
      const g = grouped()
      let picked = contact ? resolveContact(contact) : null
      let msgs: any[]
      if (picked) {
        msgs = backlog(g.get(picked) ?? [], picked)
      } else {
        let best = 0
        for (const [c, rows] of g) { const n = backlog(rows, c).length; if (n > best) { picked = c; best = n } }
        msgs = picked ? backlog(g.get(picked)!, picked) : []
      }
      msgs = msgs.slice(0, limit)
      if (msgs.length === 0) return { done: true }
      const last = msgs[msgs.length - 1]
      const dm = displayMap()
      return {
        batch_id: encodeBatchId(picked!, last.time, last.local_id),
        contact: picked, display: dm.get(picked!) ?? picked,
        covers_until_ts: last.time,
        messages: msgs.map((m) => ({ msg_key: m.msg_key, sender: dm.get(m.sender) ?? m.sender, time: m.time, text: m.text })),
      }
    },
    record(batchId, facts, now) {
      const [contact, ts, localId] = decodeBatchId(batchId)
      let inserted = 0, merged = 0
      for (const f of facts ?? []) {
        const withContact = { ...f, contact: f.contact ?? contact }
        if (store.upsertFact(withContact, now) === 'inserted') inserted++; else merged++
      }
      store.advanceFactWatermark(contact, ts, localId, now)
      return { recorded: inserted, merged, advanced_to: store.factWatermark(contact)[0] }
    },
    contactFacts(name) {
      const un = resolveContact(name)
      const by_kind: Record<string, any[]> = {}
      for (const f of store.factsForContact(un, 'active')) (by_kind[f.kind ?? 'unknown'] ??= []).push(f)
      return { resolved: true, contact: un, display: displayMap().get(un) ?? un, by_kind }
    },
    findFacts(kind, predicate, query, status, limit) {
      return { results: store.findFactRows(kind, predicate, query, status ?? 'active', limit ?? 50) }
    },
    setFactStatus(id, status, now) { return { ok: store.setFactStatusById(id, status, now) } },
    extractionStatus() {
      const g = grouped(); const per: any[] = []; let caught = 0
      for (const [c, rows] of g) {
        const remaining = backlog(rows, c).length
        if (remaining === 0) caught++
        per.push({ contact: c, extracted_until: store.factWatermark(c)[0], remaining })
      }
      per.sort((a, b) => b.remaining - a.remaining)
      return { contacts: g.size, caught_up: caught, facts_by_kind: store.factCountsByKind(), backlog: per.slice(0, 50) }
    },
  }
}
