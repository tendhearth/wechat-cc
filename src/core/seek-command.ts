/**
 * seek-command.ts — the WeChat 派 / 取消 心愿 triggers (spec
 * 2026-09-04-wish-postcard). Deterministic pipeline-layer parse, mirroring
 * pair-command.ts / visit-command.ts (never relies on the model noticing).
 * The ref is resolved against the wish list by `WishService.resolveRef`, not
 * here — this file only decides "is this a 派/取消 command, and for what ref".
 */
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
