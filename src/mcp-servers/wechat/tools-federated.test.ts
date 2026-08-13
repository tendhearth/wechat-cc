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

  it('buckets confidence by score thresholds (0.66 / 0.33)', () => {
    expect(reshapeToFederatedHits([item({ score: 0.9 })])[0]!.confidence).toBe('high')
    expect(reshapeToFederatedHits([item({ score: 0.67 })])[0]!.confidence).toBe('high')
    expect(reshapeToFederatedHits([item({ score: 0.66 })])[0]!.confidence).toBe('medium')
    expect(reshapeToFederatedHits([item({ score: 0.5 })])[0]!.confidence).toBe('medium')
    expect(reshapeToFederatedHits([item({ score: 0.33 })])[0]!.confidence).toBe('low')
    expect(reshapeToFederatedHits([item({ score: 0.1 })])[0]!.confidence).toBe('low')
  })

  it('clamps match_score into [0,1] even for raw RRF scores outside that range', () => {
    // semanticSearch's score is an RRF rank score (fused.length - rank), NOT
    // pre-normalized — it can be > 1 for a strong hit. match_score must
    // still land in [0,1] per the hearth contract.
    expect(reshapeToFederatedHits([item({ score: 12 })])[0]!.match_score).toBe(1)
    expect(reshapeToFederatedHits([item({ score: -3 })])[0]!.match_score).toBe(0)
    expect(reshapeToFederatedHits([item({ score: 0.5 })])[0]!.match_score).toBe(0.5)
    for (const hit of reshapeToFederatedHits([item({ score: 12 }), item({ score: -3 }), item({ score: 0.42 })])) {
      expect(hit.match_score).toBeGreaterThanOrEqual(0)
      expect(hit.match_score).toBeLessThanOrEqual(1)
    }
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
