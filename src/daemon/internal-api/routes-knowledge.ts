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
 * POST /v1/knowledge/search embedding note: query-text embedding is a
 * daemon-side model call deferred out of this slice — the caller must
 * supply a pre-embedded `queryVector` in the body. Absent ⇒ 400
 * query_vector_required (NOT 503 — the store is wired, the caller just
 * skipped a required field). A later slice can add an optional
 * `deps.knowledge.embedQuery` fallback that embeds `body.query` itself.
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
      if (typeof b.model_id !== 'string' || b.model_id.length === 0) {
        return { status: 400, body: { error: 'invalid_model_id' } }
      }
      const limit = typeof b.limit === 'number' && Number.isFinite(b.limit) && b.limit > 0 ? b.limit : 20
      if (!Array.isArray(b.queryVector)) return { status: 400, body: { error: 'query_vector_required' } }
      const result = deps.knowledge.search(deps.knowledge.store, {
        queryVector: b.queryVector as number[],
        queryText: b.query,
        model_id: b.model_id,
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
  }
}
