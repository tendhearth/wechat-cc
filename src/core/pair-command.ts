/**
 * pair-command.ts — the WeChat 配对 trigger (spec §7). Deterministic pipeline-layer
 * parse, mirroring reveal-command.ts / penpal-letter-command.ts (never relies on
 * the model noticing). Bare "配对" → start; "配对 <6 digits>" → accept.
 */
export function parsePairCommand(text: string): { kind: 'start' } | { kind: 'accept'; code: string } | null {
  const t = text.trim()
  if (/^配对$/.test(t)) return { kind: 'start' }
  const m = t.match(/^配对\s+(\d{6})$/)
  if (m) return { kind: 'accept', code: m[1]! }
  return null
}
