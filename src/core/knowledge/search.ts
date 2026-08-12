/**
 * Semantic search — the Query-face `semantic_search`: cosine (over a single
 * model_id's vectors) + FTS5 bm25, fused with Reciprocal Rank Fusion (RRF).
 *
 * A 1:1 TS port of the reviewed Python (wechat-cc-plugins/packages/wxsearch/
 * wxsearch/search.py `rrf()` + `search()`), running over the KnowledgeStore
 * (src/core/knowledge/store.ts, T1) instead of wxsearch's own sidecar index.
 *
 * Provenance keeps this safe: `store.loadVectors(model_id)` returns only that
 * model's vectors (uniform dim), so the matmul below can never mix dimensions.
 * The extra query-vector-length guard in cosineTopK is defense-in-depth for
 * the case a caller passes a vector from a different model under the same
 * model_id label (the T1 review's per-row/dim-mismatch concern).
 */
import type { DocSummary, KnowledgeStore } from './store'

export interface SemanticSearchOpts {
  queryVector: number[]
  queryText: string
  model_id: string
  limit: number
  conversation?: string
}

export interface SemanticSearchResultItem {
  conversation: string
  sender: string
  time: number
  type: string
  text: string
  score: number
}

export interface SemanticSearchResult {
  vectors_stale: boolean
  results: SemanticSearchResultItem[]
}

/** Reciprocal Rank Fusion: score(rowid) = sum over lists of 1/(k + rank). */
export function rrf(lists: number[][], k = 60): number[] {
  const scores = new Map<number, number>()
  for (const list of lists) {
    list.forEach((rowid, rank) => {
      scores.set(rowid, (scores.get(rowid) ?? 0) + 1 / (k + rank))
    })
  }
  return Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([rowid]) => rowid)
}

/**
 * Top-k rowids by cosine similarity (plain dot product — vectors are already
 * L2-normalized by the embed model, so dot == cosine; do NOT re-normalize
 * here, matching search.py's `mat @ q`).
 */
function cosineTopK(store: KnowledgeStore, queryVector: number[], model_id: string, k: number): number[] {
  const { rowids, dim, mat } = store.loadVectors(model_id)
  if (rowids.length === 0) return []
  // Defense-in-depth: a query vector of the wrong dimension for this model's
  // stored vectors cannot be dotted against them — skip cosine rather than
  // crash or silently compute garbage similarities.
  if (dim > 0 && queryVector.length !== dim) return []

  const sims = new Float64Array(rowids.length)
  for (let i = 0; i < rowids.length; i++) {
    const base = i * dim
    let dot = 0
    for (let j = 0; j < dim; j++) dot += mat[base + j]! * queryVector[j]!
    sims[i] = dot
  }

  const order = Array.from(sims.keys()).sort((a, b) => sims[b]! - sims[a]!)
  return order.slice(0, k).map(i => rowids[i]!)
}

export function semanticSearch(store: KnowledgeStore, opts: SemanticSearchOpts): SemanticSearchResult {
  const { queryVector, queryText, model_id, limit, conversation } = opts
  const pool = Math.max(limit * 5, 50)

  const kw = store.keywordSearch(queryText, pool)

  const indexedModel = store.getMeta('embed_model')
  const vectors_stale = indexedModel !== null && indexedModel !== model_id

  const vec = vectors_stale ? [] : cosineTopK(store, queryVector, model_id, pool)
  const fused = vec.length ? rrf([vec, kw]) : kw

  const docs: Map<number, DocSummary> = store.getDocs(fused)
  const results: SemanticSearchResultItem[] = []
  for (let rank = 0; rank < fused.length; rank++) {
    const doc = docs.get(fused[rank]!)
    if (!doc) continue
    if (conversation && doc.conversation !== conversation) continue
    results.push({
      conversation: doc.conversation,
      sender: doc.sender,
      time: doc.time,
      type: doc.kind,
      text: doc.text,
      score: fused.length - rank,
    })
    if (results.length >= limit) break
  }

  return { vectors_stale, results }
}
