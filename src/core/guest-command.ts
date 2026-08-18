/**
 * guest-command.ts — the WeChat guest-path owner triggers (spec §3).
 * Deterministic pipeline-layer parse, mirroring pair-command.ts /
 * reveal-command.ts / penpal-letter-command.ts (never relies on the model
 * noticing). "允许 <6 digits>" / "拒绝 <6 digits>" / bare "邀请码" /
 * bare "待批准" — anything else, including extra surrounding text, is
 * null (deterministic commands don't do fuzzy matching).
 */
export type GuestCommand =
  | { kind: 'allow'; code: string }
  | { kind: 'deny'; code: string }
  | { kind: 'invite' }
  | { kind: 'pending' }

export function parseGuestCommand(text: string): GuestCommand | null {
  const t = text.trim()
  if (/^邀请码$/.test(t)) return { kind: 'invite' }
  if (/^待批准$/.test(t)) return { kind: 'pending' }
  const allow = t.match(/^允许\s+(\d{6})$/)
  if (allow) return { kind: 'allow', code: allow[1]! }
  const deny = t.match(/^拒绝\s+(\d{6})$/)
  if (deny) return { kind: 'deny', code: deny[1]! }
  return null
}
