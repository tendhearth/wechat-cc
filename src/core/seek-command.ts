/**
 * seek-command.ts — the WeChat 派 / 取消 (confirm / cancel a proposed wish)
 * triggers (P4 派心愿). Deterministic pipeline-layer parse, mirroring
 * pair-command.ts / reveal-command.ts (never relies on the model noticing).
 */
import type { SeekRow } from './social-seek-store'

export type SeekCommand = { kind: 'confirm'; ref: string } | { kind: 'cancel'; ref: string }

// The ref is an intent_id (randomUUID) or a prefix of one — hex + hyphen ONLY.
// Constraining the charset makes 派 <id> structurally disjoint from
// admin-commands.ts's DELEGATE_RE (让/派 <hand> 执行/跑 <task>): a token
// containing 执行/跑 or any CJK hand name can never match [0-9a-fA-F-]+.
const REF = '#?([0-9a-fA-F-]+)'

export function parseSeekCommand(text: string): SeekCommand | null {
  const t = text.trim()
  let m = t.match(new RegExp(`^派\\s+${REF}$`))
  if (m) return { kind: 'confirm', ref: m[1]! }
  m = t.match(new RegExp(`^取消\\s+${REF}$`))
  if (m) return { kind: 'cancel', ref: m[1]! }
  return null
}

export type SeekRefResolution = { ok: true; id: string } | { ok: false; reason: 'not_found' | 'ambiguous' }

export function resolveSeekRef(ref: string, rows: SeekRow[]): SeekRefResolution {
  const proposed = rows.filter(r => r.status === 'proposed')
  const exact = proposed.find(r => r.id === ref)
  if (exact) return { ok: true, id: exact.id }
  if (ref.length < 6) return { ok: false, reason: 'ambiguous' } // too short to prefix-match safely
  const hits = proposed.filter(r => r.id.startsWith(ref))
  if (hits.length === 1) return { ok: true, id: hits[0]!.id }
  if (hits.length > 1) return { ok: false, reason: 'ambiguous' }
  return { ok: false, reason: 'not_found' }
}
