/**
 * internal-api Knowledge Kernel route table (Phase 01 Task 3) — the
 * Ingest + Query surface over src/core/knowledge/store.ts (T1) and
 * src/core/knowledge/search.ts (T2). Mirrors routes-social.ts's shape:
 * `export function knowledgeRoutes(deps: InternalApiDeps): RouteTable`,
 * 503 when the store isn't wired, inline body validation (no
 * REQUEST_SCHEMAS entry), `{ status, body }` returns.
 *
 * Ingest face (source/put, semantic/put) is written by the source adapter
 * job + wxsearch's indexer — see docs/superpowers/specs/
 * 2026-07-12-knowledge-kernel-phase01-design.md "Knowledge API". Query face
 * (messages, search, semantic/status) is read by anything paging source or
 * running semantic search (e.g. an agent's search tool).
 *
 * POST /v1/knowledge/search embedding (Agent-facing Search T3): the caller
 * may supply a pre-embedded `queryVector` (+ `model_id`) directly, or — when
 * `deps.knowledge.embedder`/`embedQuery` is wired — omit it and let the
 * route embed `body.query` itself via the shared embedder service. On the
 * embedder path the resulting `model_id` is ALWAYS the embedder's own
 * `model_id`, never the caller-supplied one (I2 closure: query + index must
 * share one model space, and the embedder is the single source of truth for
 * what that space is). Neither a vector nor an embedder available ⇒ 400
 * query_vector_required (NOT 503 — the store is wired, the caller just
 * skipped a required field / the indexer isn't configured).
 */
import type { InternalApiDeps, RouteTable } from './types'

const DEFAULT_MESSAGES_LIMIT = 500
const MAX_MESSAGES_LIMIT = 2000

export function knowledgeRoutes(deps: InternalApiDeps): RouteTable {
  return {
    'POST /v1/knowledge/source/put': async (_q, body) => {
      if (!deps.knowledge) return { status: 503, body: { error: 'knowledge_not_wired' } }
      const messages = ((body ?? {}) as { messages?: unknown }).messages
      if (!Array.isArray(messages)) return { status: 400, body: { error: 'invalid_messages' } }
      const { watermark } = deps.knowledge.store.putSourceMessages(messages as never)
      return { status: 200, body: { ok: true, watermark } }
    },

    // 换 provider 交接的 Amp 式逃生口(provider-handoff.ts):按 chat 查
    // 近期原文或全文搜索 —— 面向 agent 的 chat_history 工具后端。
    'GET /v1/chat/history': async (q) => {
      if (!deps.messages) return { status: 503, body: { error: 'messages_not_wired' } }
      const chatId = q.get('chatId')
      if (!chatId) return { status: 400, body: { error: 'chatId_required' } }
      const rawLimit = Number(q.get('limit') ?? '30')
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.trunc(rawLimit), 200) : 30
      const query = q.get('query')
      const rows = query && query.trim().length > 0
        ? await deps.messages.search(chatId, query.trim(), limit)
        : await deps.messages.listRange(chatId, { limit, ...(q.get('before') ? { beforeTs: q.get('before')! } : {}) })
      return { status: 200, body: { messages: rows.map(r => ({ ts: r.ts, dir: r.direction, kind: r.kind, text: r.text })) } }
    },
    'GET /v1/knowledge/messages': (q) => {
      if (!deps.knowledge) return { status: 503, body: { error: 'knowledge_not_wired' } }
      const since = Number(q.get('since_watermark') ?? '0')
      const sinceWatermark = Number.isFinite(since) ? since : 0
      const rawLimit = Number(q.get('limit') ?? String(DEFAULT_MESSAGES_LIMIT))
      const limit = Math.min(
        Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_MESSAGES_LIMIT,
        MAX_MESSAGES_LIMIT,
      )
      const { messages, watermark } = deps.knowledge.store.listMessages(sinceWatermark, limit)
      return { status: 200, body: { messages, watermark } }
    },

    'POST /v1/knowledge/semantic/put': async (_q, body) => {
      if (!deps.knowledge) return { status: 503, body: { error: 'knowledge_not_wired' } }
      const b = (body ?? {}) as { model_id?: unknown; model_version?: unknown; chunks?: unknown }
      if (typeof b.model_id !== 'string' || b.model_id.length === 0) {
        return { status: 400, body: { error: 'invalid_model_id' } }
      }
      if (typeof b.model_version !== 'string' || b.model_version.length === 0) {
        return { status: 400, body: { error: 'invalid_model_version' } }
      }
      if (!Array.isArray(b.chunks)) return { status: 400, body: { error: 'invalid_chunks' } }
      deps.knowledge.store.putSemantic(b.model_id, b.model_version, b.chunks as never)
      return { status: 200, body: { ok: true } }
    },

    'POST /v1/knowledge/search': async (_q, body) => {
      if (!deps.knowledge) return { status: 503, body: { error: 'knowledge_not_wired' } }
      const b = (body ?? {}) as {
        query?: unknown
        model_id?: unknown
        limit?: unknown
        conversation?: unknown
        queryVector?: unknown
      }
      if (typeof b.query !== 'string' || b.query.length === 0) return { status: 400, body: { error: 'invalid_query' } }
      const limit = typeof b.limit === 'number' && Number.isFinite(b.limit) && b.limit > 0 ? b.limit : 20

      let queryVector: number[]
      let model_id: string
      if (Array.isArray(b.queryVector) && b.queryVector.length > 0) {
        // Explicit-vector path (unchanged): caller supplies both the vector
        // and the model_id it was embedded under.
        if (typeof b.model_id !== 'string' || b.model_id.length === 0) {
          return { status: 400, body: { error: 'invalid_model_id' } }
        }
        queryVector = b.queryVector as number[]
        model_id = b.model_id
      } else if (deps.knowledge.embedder && deps.knowledge.embedQuery) {
        // Embedder-fallback path (I2 closure): the embedder is the single
        // source of truth for the model space, so any caller-supplied
        // model_id is ignored here — using it would risk querying against a
        // different space than the vector was just embedded into.
        queryVector = await deps.knowledge.embedQuery(b.query)
        model_id = deps.knowledge.embedder.model_id
      } else {
        return { status: 400, body: { error: 'query_vector_required' } }
      }

      const result = deps.knowledge.search(deps.knowledge.store, {
        queryVector,
        queryText: b.query,
        model_id,
        limit,
        conversation: typeof b.conversation === 'string' ? b.conversation : undefined,
      })
      return { status: 200, body: result }
    },

    'GET /v1/knowledge/semantic/status': () => {
      if (!deps.knowledge) return { status: 503, body: { error: 'knowledge_not_wired' } }
      const model_id = deps.knowledge.store.getMeta('embed_model')
      return {
        status: 200,
        body: {
          indexed: deps.knowledge.store.countSemantic(model_id ?? undefined),
          model_id,
          model_version: deps.knowledge.store.getMeta('embed_model_version'),
        },
      }
    },

    // ---- Graph Query (Knowledge Graph inproc, Task 5) ----------------------
    // Admin-only (see route-tiers.ts + user-tier.ts's ADMIN_ONLY) — reads the
    // owner's full contact/relationship graph, same private-data trust class
    // as /v1/knowledge/search above. 503 knowledge_not_wired when the
    // knowledge store isn't configured at all; `!deps.knowledge.graph`
    // specifically means `knowledge_enabled` is on but graph-query wasn't
    // wired (shouldn't happen once bootstrap wires it unconditionally
    // alongside `store`, but mirrors the other routes' defensive posture).
    'POST /v1/knowledge/graph/contact_profile': (_q, body) => {
      if (!deps.knowledge?.graph) return { status: 503, body: { error: 'knowledge_not_wired' } }
      const b = (body ?? {}) as { name?: unknown }
      if (typeof b.name !== 'string' || b.name.length === 0) return { status: 400, body: { error: 'invalid_name' } }
      return { status: 200, body: deps.knowledge.graph.contactProfile(b.name) }
    },

    'POST /v1/knowledge/graph/top_contacts': (_q, body) => {
      if (!deps.knowledge?.graph) return { status: 503, body: { error: 'knowledge_not_wired' } }
      const b = (body ?? {}) as { by?: unknown; limit?: unknown; kind?: unknown }
      const by = typeof b.by === 'string' && b.by.length > 0 ? b.by : 'closeness'
      const limit = typeof b.limit === 'number' && Number.isFinite(b.limit) && b.limit > 0 ? b.limit : 20
      const kind = b.kind === 'group' ? 'group' : 'person'
      return { status: 200, body: { contacts: deps.knowledge.graph.topContacts(by, limit, kind) } }
    },

    'POST /v1/knowledge/graph/rank_contacts': (_q, body) => {
      if (!deps.knowledge?.graph) return { status: 503, body: { error: 'knowledge_not_wired' } }
      const b = (body ?? {}) as { topic?: unknown; limit?: unknown }
      const topic = typeof b.topic === 'string' ? b.topic : undefined
      const limit = typeof b.limit === 'number' && Number.isFinite(b.limit) && b.limit > 0 ? b.limit : 20
      return { status: 200, body: { contacts: deps.knowledge.graph.rankContacts(topic, limit) } }
    },

    'POST /v1/knowledge/graph/relationship_subgraph': (_q, body) => {
      if (!deps.knowledge?.graph) return { status: 503, body: { error: 'knowledge_not_wired' } }
      const b = (body ?? {}) as { center?: unknown; limit?: unknown }
      const center = typeof b.center === 'string' ? b.center : undefined
      const limit = typeof b.limit === 'number' && Number.isFinite(b.limit) && b.limit > 0 ? b.limit : 30
      return { status: 200, body: deps.knowledge.graph.relationshipSubgraph(center, limit) }
    },

    'POST /v1/knowledge/graph/connectors': (_q, body) => {
      if (!deps.knowledge?.graph) return { status: 503, body: { error: 'knowledge_not_wired' } }
      const b = (body ?? {}) as { a?: unknown; b?: unknown }
      if (typeof b.a !== 'string' || b.a.length === 0) return { status: 400, body: { error: 'invalid_a' } }
      if (typeof b.b !== 'string' || b.b.length === 0) return { status: 400, body: { error: 'invalid_b' } }
      return { status: 200, body: deps.knowledge.graph.connectors(b.a, b.b) }
    },

    'GET /v1/knowledge/graph/status': () => {
      if (!deps.knowledge?.graph) return { status: 503, body: { error: 'knowledge_not_wired' } }
      return { status: 200, body: deps.knowledge.graph.status() }
    },

    // ---- Facts + Person (Knowledge Facts/Person inproc, Task 4) ------------
    // Admin-only (see route-tiers.ts) — same private-data trust class as the
    // graph routes above: reads/writes the owner's private fact store and
    // per-contact briefs. 503 knowledge_not_wired when the knowledge store
    // isn't configured at all; `!deps.knowledge.facts`/`.person` specifically
    // means `knowledge_enabled` is on but facts/person weren't wired
    // (shouldn't happen once bootstrap wires them unconditionally alongside
    // `store`, but mirrors the other routes' defensive posture).
    'POST /v1/knowledge/facts/extraction_batch': (_q, body) => {
      if (!deps.knowledge?.facts) return { status: 503, body: { error: 'knowledge_not_wired' } }
      const b = (body ?? {}) as { contact?: string; limit?: number }
      return { status: 200, body: deps.knowledge.facts.nextBatch(b.contact ?? null, b.limit ?? 40) }
    },
    'POST /v1/knowledge/facts/record_facts': (_q, body) => {
      if (!deps.knowledge?.facts) return { status: 503, body: { error: 'knowledge_not_wired' } }
      const b = (body ?? {}) as { batch_id?: unknown; facts?: unknown; now?: number }
      if (typeof b.batch_id !== 'string' || !b.batch_id) return { status: 400, body: { error: 'invalid_batch_id' } }
      return {
        status: 200,
        body: deps.knowledge.facts.record(b.batch_id, (b.facts as any[]) ?? [], b.now ?? Math.floor(Date.now() / 1000)),
      }
    },
    'POST /v1/knowledge/facts/contact_facts': (_q, body) => {
      if (!deps.knowledge?.facts) return { status: 503, body: { error: 'knowledge_not_wired' } }
      const b = (body ?? {}) as { name?: unknown }
      if (typeof b.name !== 'string' || !b.name) return { status: 400, body: { error: 'invalid_name' } }
      return { status: 200, body: deps.knowledge.facts.contactFacts(b.name) }
    },
    'POST /v1/knowledge/facts/find_facts': (_q, body) => {
      if (!deps.knowledge?.facts) return { status: 503, body: { error: 'knowledge_not_wired' } }
      const b = (body ?? {}) as any
      return {
        status: 200,
        body: deps.knowledge.facts.findFacts(b.kind ?? null, b.predicate ?? null, b.query ?? null, b.status ?? 'active', b.limit ?? 50),
      }
    },
    'POST /v1/knowledge/facts/set_fact_status': (_q, body) => {
      if (!deps.knowledge?.facts) return { status: 503, body: { error: 'knowledge_not_wired' } }
      const b = (body ?? {}) as { id?: unknown; status?: unknown; now?: number }
      if (typeof b.id !== 'number' || typeof b.status !== 'string' || !b.status) return { status: 400, body: { error: 'invalid_args' } }
      return { status: 200, body: deps.knowledge.facts.setFactStatus(b.id, b.status, b.now ?? Math.floor(Date.now() / 1000)) }
    },
    'GET /v1/knowledge/facts/extraction_status': () => {
      if (!deps.knowledge?.facts) return { status: 503, body: { error: 'knowledge_not_wired' } }
      return { status: 200, body: deps.knowledge.facts.extractionStatus() }
    },
    'POST /v1/knowledge/person/brief': (_q, body) => {
      if (!deps.knowledge?.person) return { status: 503, body: { error: 'knowledge_not_wired' } }
      const b = (body ?? {}) as { name?: unknown; recent_n?: number }
      if (typeof b.name !== 'string' || !b.name) return { status: 400, body: { error: 'invalid_name' } }
      return { status: 200, body: deps.knowledge.person.personBrief(b.name, b.recent_n ?? 12) }
    },
  }
}
