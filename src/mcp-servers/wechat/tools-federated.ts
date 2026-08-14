/**
 * wechat-mcp federated-query tool (memory-infra Phase 2a, HF W1) — lets a
 * federated memory layer (hearth) query the owner's WeChat knowledge and get
 * back hearth-compatible cited hits, instead of the raw knowledge_search
 * shape. Admin-only (see user-tier.ts ADMIN_ONLY): it exposes the same
 * private message history as knowledge_search, just reshaped for a
 * cross-app caller. Mirrors tools-knowledge.ts's registerKnowledgeSearchTool
 * shape — same client/gate plumbing, only the output is different.
 *
 * Reuses the EXACT retrieval knowledge_search uses (`POST
 * /v1/knowledge/search`, which embeds the query + runs semanticSearch — see
 * routes-knowledge.ts and core/knowledge/search.ts) — only the response
 * shape differs: each `SemanticSearchResultItem` is reshaped into a
 * `{claim_text, source, anchor_summary, confidence, match_score}` hit hearth
 * expects, instead of passing the search route's raw body through.
 *
 * `item.time` is WeChat's `create_time`, which is UNIX SECONDS (not ms —
 * see source-adapter.ts's `create_time` and the "WeChat `create_time` is
 * only second-granular" note in docs/superpowers/specs/
 * 2026-08-12-knowledge-facts-person-inproc-design.md), so the anchor is
 * built as `new Date(item.time * 1000).toISOString()`.
 *
 * `SemanticSearchResultItem.score` is an RRF-fused rank score (see
 * core/knowledge/search.ts's `semanticSearch`) — `fused.length - rank`,
 * which is >= 1 for EVERY real hit, not a [0,1] similarity. Naively clamping
 * it (`Math.max(0, Math.min(1, score))`) saturates every hit to exactly
 * 1.0/'high', which in hearth's merge (sort by match_score desc) buries
 * every local vault hit under every wechat hit regardless of relevance —
 * the opposite of A4's "normalize match_score to a common 0-1 scale". So
 * `match_score`/`confidence` are instead derived from the hit's RANK (its
 * position in `results`, which `semanticSearch` already returns in
 * relevance order): `match_score = 1 / (1 + index)` — a proper strictly-
 * descending 0-1 scale (1.0, 0.5, 0.333, ...) that differentiates hits by
 * their own relative order instead of collapsing them all to the ceiling.
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { InternalApiClient } from './client'
import { passthroughErrorResult } from './tool-helpers'
import type { SemanticSearchResultItem } from '../../core/knowledge/search'

export interface FederatedHit {
  claim_text: string
  source: string
  anchor_summary: string
  confidence: 'high' | 'medium' | 'low'
  match_score: number
}

/**
 * Pure reshape from the knowledge search route's result items into
 * hearth-compatible hits. Exported (unlike tools-knowledge.ts's inline
 * passthrough) so the reshape logic — the only genuinely new behavior this
 * tool adds — is unit-testable without spinning up an MCP server or a
 * fetch-mocked InternalApiClient.
 *
 * `match_score`/`confidence` are rank-derived, NOT taken from the raw
 * `item.score` (see the module doc comment for why: the raw RRF score is
 * unbounded-above and would saturate every hit to match_score=1). `items`
 * is assumed already relevance-ordered (semanticSearch's contract), so the
 * `.map` index IS the rank.
 */
export function reshapeToFederatedHits(items: readonly SemanticSearchResultItem[]): FederatedHit[] {
  return items.map((item, index) => {
    const match_score = 1 / (1 + index)
    return {
      claim_text: item.text,
      source: `wechat:${item.conversation}`,
      anchor_summary: new Date(item.time * 1000).toISOString(),
      confidence: index === 0 ? 'high' : index <= 2 ? 'medium' : 'low',
      match_score,
    }
  })
}

export function registerFederatedQueryTool(server: McpServer, client: InternalApiClient): void {
  server.registerTool(
    'federated_query',
    {
      title: '为联邦记忆层（hearth）查询机主的微信知识',
      description: '供外部联邦记忆层（hearth）查询机主的微信消息知识，返回可引用的检索结果（claim_text/source/anchor_summary/confidence/match_score）。仅管理员可用。',
      inputSchema: {
        question: z.string().describe('要检索的问题，例如"上次聊到的那个报销流程"'),
      },
    },
    async ({ question }) => {
      try {
        const resp = await client.request<{ results?: SemanticSearchResultItem[] }>(
          'POST',
          '/v1/knowledge/search',
          { query: question },
        )
        const hits = reshapeToFederatedHits(resp?.results ?? [])
        return { content: [{ type: 'text', text: JSON.stringify({ hits }) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'federated_query')
      }
    },
  )
}
