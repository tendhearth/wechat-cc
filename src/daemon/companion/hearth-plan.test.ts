import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { parse as parseYaml } from 'yaml'
import { buildHearthPlan, type Claim } from './hearth-plan'

// Pins hearth's REAL hash format (src/core/hash.ts): 'sha256:' + hex digest,
// not bare hex. hearth's verifyClaim recomputes with this exact helper and
// does a strict === (no prefix-stripping) — a bare-hex hash here would make
// every claim fail verification with hash_mismatch.
function sha256(s: string): string {
  return 'sha256:' + createHash('sha256').update(s).digest('hex')
}

// Fixed 3-section digest shaped exactly like distillOwnerKnowledge's output
// (see src/daemon/companion/knowledge-distill.ts).
const DIGEST = `## 你的社交状态（算出来的，非主观）

**未了义务**
- 完成给小明的礼物
- 回复老王的消息

**亲近的人**
- 小红、小刚

**好久没联系**
- 老李`

const NOW = 1755043200000 // fixed instant, injected (no Date.now() inside buildHearthPlan)

/** Split a frontmatter+body markdown string into { frontmatterYaml, value }. */
function splitFrontmatter(page: string): { yaml: string; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(page)
  if (!m) throw new Error('page has no --- frontmatter delimiters')
  return { yaml: m[1]!, body: m[2]! }
}

describe('buildHearthPlan', () => {
  it('sets stable plan-level metadata', () => {
    const plan = buildHearthPlan(DIGEST, NOW)
    expect(plan.change_id).toBe(`wechat-social-state-${NOW}`)
    expect(plan.source_id).toBe(sha256(DIGEST))
    expect(plan.risk).toBe('low')
    expect(plan.requires_review).toBe(false)
    expect(plan.created_at).toBe(new Date(NOW).toISOString())
  })

  it('produces exactly a source-page create op and a concept-page create op', () => {
    const plan = buildHearthPlan(DIGEST, NOW)
    expect(plan.ops).toHaveLength(2)

    const [sourceOp, conceptOp] = plan.ops
    expect(sourceOp!.op).toBe('create')
    expect(sourceOp!.path).toBe('raw/wechat/social-state.md')
    expect(sourceOp!.precondition).toEqual({ exists: false })
    expect(sourceOp!.patch?.type).toBe('replace')
    expect(typeof sourceOp!.reason).toBe('string')
    expect(sourceOp!.reason.length).toBeGreaterThan(0)

    expect(conceptOp!.op).toBe('create')
    expect(conceptOp!.path).toBe('wechat/social-state.md')
    expect(conceptOp!.precondition).toEqual({ exists: false })
    expect(conceptOp!.patch?.type).toBe('replace')
  })

  it('the source page contains the digest verbatim plus a small YAML frontmatter', () => {
    const plan = buildHearthPlan(DIGEST, NOW)
    const sourceValue = plan.ops[0]!.patch!.value
    expect(sourceValue.startsWith('---\n')).toBe(true)
    expect(sourceValue).toContain('channel: wechat')
    expect(sourceValue).toContain(`generated_at: ${new Date(NOW).toISOString()}`)
    expect(sourceValue.endsWith(DIGEST)).toBe(true)
  })

  it('source_id is hearth-format sha256 ("sha256:"+hex) of the raw digest (not the wrapped source page)', () => {
    const plan = buildHearthPlan(DIGEST, NOW)
    expect(plan.source_id.startsWith('sha256:')).toBe(true)
    expect(plan.source_id).toBe('sha256:' + createHash('sha256').update(DIGEST).digest('hex'))
    expect(plan.source_id).toBe(sha256(DIGEST))
    expect(plan.source_id).not.toBe(sha256(plan.ops[0]!.patch!.value))
  })

  it('the concept page frontmatter has a valid, parseable claims: list, one per digest bullet', () => {
    const plan = buildHearthPlan(DIGEST, NOW)
    const conceptValue = plan.ops[1]!.patch!.value
    const { yaml } = splitFrontmatter(conceptValue)
    const parsed = parseYaml(yaml) as { claims: Claim[] }
    expect(Array.isArray(parsed.claims)).toBe(true)
    // 4 bullets total in the fixed DIGEST fixture (2 + 1 + 1)
    expect(parsed.claims).toHaveLength(4)
    for (const claim of parsed.claims) {
      expect(claim.source).toBe('raw/wechat/social-state.md')
      expect(claim.confidence).toBe('high')
      expect(claim.anchor.type).toBe('line')
      expect(typeof claim.text).toBe('string')
      expect(claim.text.length).toBeGreaterThan(0)
    }
  })

  it('THE CRUX: every claim quote is a verbatim substring of the source page, hash-matches, and its line_start..line_end slice of the source page equals the quote', () => {
    const plan = buildHearthPlan(DIGEST, NOW)
    const sourceValue = plan.ops[0]!.patch!.value
    const conceptValue = plan.ops[1]!.patch!.value
    const sourceLines = sourceValue.split('\n')

    const { yaml } = splitFrontmatter(conceptValue)
    const parsed = parseYaml(yaml) as { claims: Claim[] }

    expect(parsed.claims.length).toBeGreaterThan(0)
    for (const claim of parsed.claims) {
      const { quote, quote_hash, line_start, line_end } = claim.anchor

      // (a) verbatim substring of the source page
      expect(sourceValue.includes(quote)).toBe(true)

      // (b) hash matches recomputation, in hearth's REAL 'sha256:'-prefixed
      // format (bare hex was Round 1's bug — hearth's verifyClaim does a
      // strict === with no prefix-stripping, so the prefix is load-bearing).
      expect(quote_hash.startsWith('sha256:')).toBe(true)
      expect(quote_hash).toBe('sha256:' + createHash('sha256').update(quote).digest('hex'))
      expect(quote_hash).toBe(sha256(quote))

      // (c) the source page's [line_start..line_end] (1-based) equals the quote
      expect(line_start).toBeGreaterThanOrEqual(1)
      expect(line_end).toBeGreaterThanOrEqual(line_start)
      const slice = sourceLines.slice(line_start - 1, line_end).join('\n')
      expect(slice).toBe(quote)
    }
  })

  it('is pure/deterministic: same digest+now yields byte-identical output', () => {
    const a = buildHearthPlan(DIGEST, NOW)
    const b = buildHearthPlan(DIGEST, NOW)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('handles an empty digest (nothing to distill) without throwing, with zero claims', () => {
    const plan = buildHearthPlan('', NOW)
    expect(plan.ops).toHaveLength(2)
    const conceptValue = plan.ops[1]!.patch!.value
    const { yaml } = splitFrontmatter(conceptValue)
    const parsed = parseYaml(yaml) as { claims: Claim[] }
    expect(parsed.claims).toEqual([])
    expect(plan.source_id).toBe(sha256(''))
  })
})
