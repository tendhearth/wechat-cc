/**
 * Build a hearth `ChangePlan` from wechat-cc's distilled owner-knowledge
 * digest (`distillOwnerKnowledge`'s markdown output — the owner's
 * social-state digest, see knowledge-distill.ts). Pure builder: no MCP, no
 * I/O, no `Date.now()` — `now` is injected so the plan is byte-deterministic
 * for a given (digest, now) pair. hearth (over MCP, via hearth-client.ts)
 * VALIDATES this plan and VERIFIES every claim's citation — this module's
 * whole job is producing anchors hearth's verifier will accept:
 *   - `quote` is a verbatim substring of the emitted source-page text
 *   - `quote_hash === sha256(quote)`
 *   - the source page's `[line_start..line_end]` (1-based, split by '\n')
 *     equals `quote` exactly
 * The source page is built FIRST and its lines are what every claim anchor
 * is computed against, so these three properties hold by construction.
 *
 * hearth v0.1 only verifies `type:'line'` anchors and only applies
 * `patch.type:'replace'` ops, so that's all this builder emits.
 */
import { createHash } from 'node:crypto'
import { stringify as stringifyYaml } from 'yaml'

// ---- Local mirror of hearth's src/core/types.ts. Do NOT import from the
// hearth repo — the boundary between wechat-cc and hearth is MCP, not a
// shared TS package. Keep this hand-in-sync with hearth's real types. ----

export interface LineAnchor {
  type: 'line'
  line_start: number
  line_end: number
  quote: string
  quote_hash: string
}

export interface Claim {
  text: string
  source: string
  anchor: LineAnchor
  confidence: 'high' | 'medium' | 'low'
}

export interface ChangeOp {
  op: 'create' | 'update' | 'delete'
  path: string
  reason: string
  precondition: { exists: boolean; base_hash?: string }
  patch?: { type: 'replace'; value: string }
  body_preview?: string
}

export interface ChangePlan {
  change_id: string
  source_id: string
  risk: 'low' | 'medium' | 'high'
  ops: ChangeOp[]
  requires_review: boolean
  created_at: string
  note?: string
}

/** Where the raw digest lands (hearth "source" page — citable, verbatim). */
const SOURCE_PATH = 'raw/wechat/social-state.md'
/** Where the claim-bearing summary lands (hearth "concept" page). */
const CONCEPT_PATH = 'wechat/social-state.md'

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

/**
 * Each `- ...` bullet line in the (already-final) source-page lines becomes
 * one single-line `Claim`. Single-line quotes keep the line_start/line_end
 * anchor trivially consistent — no multi-line quote-merging is attempted.
 */
function extractClaims(sourceLines: string[]): Claim[] {
  const claims: Claim[] = []
  sourceLines.forEach((line, idx) => {
    if (!line.startsWith('- ')) return
    const text = line.slice(2).trim()
    if (!text) return
    claims.push({
      text,
      source: SOURCE_PATH,
      anchor: {
        type: 'line',
        line_start: idx + 1,
        line_end: idx + 1,
        quote: line,
        quote_hash: sha256(line),
      },
      confidence: 'high',
    })
  })
  return claims
}

function renderConceptBody(claims: Claim[]): string {
  const lines = [
    '# wechat 社交状态',
    '',
    `来源：\`${SOURCE_PATH}\``,
  ]
  if (claims.length) {
    lines.push('', ...claims.map(c => `- ${c.text}`))
  }
  lines.push('')
  return lines.join('\n')
}

/**
 * Build a hearth ChangePlan from a distilled digest. Pure — `now` is
 * injected (never `Date.now()` internally) so the same (digest, now) pair
 * always yields byte-identical output.
 */
export function buildHearthPlan(digest: string, now: number): ChangePlan {
  const generatedAt = new Date(now).toISOString()

  // Build the source page FIRST — every claim anchor below is computed
  // against this exact string's line array, so consistency is structural.
  const sourcePage = `---\nchannel: wechat\ngenerated_at: ${generatedAt}\n---\n${digest}`
  const sourceLines = sourcePage.split('\n')
  const claims = extractClaims(sourceLines)

  const conceptFrontmatter = stringifyYaml({ claims })
  const conceptPage = `---\n${conceptFrontmatter}---\n${renderConceptBody(claims)}`

  return {
    change_id: `wechat-social-state-${now}`,
    source_id: sha256(digest),
    risk: 'low',
    requires_review: false,
    created_at: generatedAt,
    ops: [
      {
        op: 'create',
        path: SOURCE_PATH,
        reason: 'wechat social-state source digest (distillOwnerKnowledge output, verbatim)',
        precondition: { exists: false },
        patch: { type: 'replace', value: sourcePage },
      },
      {
        op: 'create',
        path: CONCEPT_PATH,
        reason: 'wechat social-state concept page with claim-level citations into the source digest',
        precondition: { exists: false },
        patch: { type: 'replace', value: conceptPage },
      },
    ],
  }
}
