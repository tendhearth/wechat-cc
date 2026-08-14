/**
 * Tests for the federated_query tool's reshape logic (memory-infra Phase 2a,
 * HF W1). The tool itself is a thin wrapper over the same
 * `/v1/knowledge/search` route knowledge_search calls (see
 * routes-knowledge.test.ts / search.test.ts for retrieval coverage) — what's
 * new here is the reshape into hearth-compatible hits, so that's what these
 * tests target directly via the exported pure `reshapeToFederatedHits`.
 * Admin-gating coverage (denied for non-admin) lives in user-tier.test.ts's
 * "federated_query tier kind" describe block, mirroring knowledge_search's.
 */
import { describe, expect, it } from 'vitest'
import { reshapeToFederatedHits } from './tools-federated'
import type { SemanticSearchResultItem } from '../../core/knowledge/search'

function item(overrides: Partial<SemanticSearchResultItem> = {}): SemanticSearchResultItem {
  return {
    conversation: 'wxid_abc123',
    sender: 'wxid_sender',
    time: 1_700_000_000, // unix seconds — WeChat create_time is second-granular
    type: 'text',
    text: '上次聊到的那个报销流程',
    score: 5,
    ...overrides,
  }
}

describe('reshapeToFederatedHits', () => {
  it('reshapes a fixture search result into a valid hearth hit', () => {
    const hits = reshapeToFederatedHits([item()])
    expect(hits).toHaveLength(1)
    const hit = hits[0]!
    expect(hit.claim_text).toBe('上次聊到的那个报销流程')
    expect(hit.source).toBe('wechat:wxid_abc123')
    // time=1_700_000_000 (unix seconds) -> ISO string via *1000
    expect(hit.anchor_summary).toBe(new Date(1_700_000_000 * 1000).toISOString())
    expect(hit.anchor_summary).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it('empty search results -> empty hits array', () => {
    expect(reshapeToFederatedHits([])).toEqual([])
  })

  it('derives match_score from RANK (1/(1+index)), not the raw RRF score', () => {
    // semanticSearch's score is an RRF rank score (fused.length - rank),
    // which is >= 1 for EVERY real hit — clamping it into [0,1] would
    // saturate every hit to exactly 1.0, burying local vault hits under
    // every wechat hit in hearth's match_score-desc merge regardless of
    // relevance. So match_score/confidence are rank-derived from each
    // item's position in the (already relevance-ordered) results array,
    // independent of the raw score value — same raw score, different rank,
    // different match_score.
    const hits = reshapeToFederatedHits([
      item({ score: 12 }),
      item({ score: 12 }),
      item({ score: 12 }),
      item({ score: 12 }),
    ])
    expect(hits.map(h => h.match_score)).toEqual([1, 0.5, 1 / 3, 0.25])
    // Strictly descending, all in (0,1].
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i]!.match_score).toBeLessThan(hits[i - 1]!.match_score)
    }
    for (const hit of hits) {
      expect(hit.match_score).toBeGreaterThan(0)
      expect(hit.match_score).toBeLessThanOrEqual(1)
    }
  })

  it('buckets confidence by rank band: index 0 high, 1-2 medium, 3+ low', () => {
    const hits = reshapeToFederatedHits([
      item({ score: 1 }),
      item({ score: 1 }),
      item({ score: 1 }),
      item({ score: 1 }),
      item({ score: 1 }),
    ])
    expect(hits.map(h => h.confidence)).toEqual(['high', 'medium', 'medium', 'low', 'low'])
  })

  it('reshapes multiple results preserving order', () => {
    const hits = reshapeToFederatedHits([
      item({ conversation: 'a', text: 'first' }),
      item({ conversation: 'b', text: 'second' }),
    ])
    expect(hits.map(h => h.claim_text)).toEqual(['first', 'second'])
    expect(hits.map(h => h.source)).toEqual(['wechat:a', 'wechat:b'])
  })
})
