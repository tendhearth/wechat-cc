/**
 * agenda.ts — pure parse/select/serialize for the companion's self-authored
 * intention list (memory/<chat>/agenda.md). Kept side-effect-free so the
 * push-tick logic is unit-testable without a daemon; `today`/`date` are
 * injected (no `new Date()` here).
 *
 * Pending line:   - [ ] due:YYYY-MM-DD <body>
 * Resolved line:  - [x] done:YYYY-MM-DD <body>   (also reads fired:/dropped:)
 * All non-matching lines (headings, prose, due-less items) are ignored.
 */

export interface AgendaItem {
  /** Exact source line — used to locate the line for in-place rewrite. */
  raw: string
  status: 'pending' | 'resolved'
  /** 'YYYY-MM-DD' for pending items; null once resolved. */
  due: string | null
  body: string
}

const PENDING_RE = /^- \[ \] due:(\d{4}-\d{2}-\d{2})\s+(.*)$/
const RESOLVED_RE = /^- \[x\] (?:done|fired|dropped):(?:\d{4}-\d{2}-\d{2})\s+(.*)$/

export function parseAgenda(md: string): AgendaItem[] {
  const items: AgendaItem[] = []
  for (const line of md.split(/\r?\n/)) {
    const p = PENDING_RE.exec(line)
    if (p) {
      items.push({ raw: line, status: 'pending', due: p[1]!, body: p[2]!.trim() })
      continue
    }
    const r = RESOLVED_RE.exec(line)
    if (r) {
      items.push({ raw: line, status: 'resolved', due: null, body: r[1]!.trim() })
    }
    // everything else: ignored
  }
  return items
}

/** Pending items due on or before `today` (YYYY-MM-DD). ISO dates sort lexicographically. */
export function selectDue(items: AgendaItem[], today: string): AgendaItem[] {
  return items.filter(i => i.status === 'pending' && i.due !== null && i.due <= today)
}

/**
 * Rewrite `item`'s line in `md` to a resolved `done:` line. Returns the new
 * file content. No-op (returns `md` unchanged) if the exact source line is no
 * longer present — so a concurrent agent edit can't be clobbered into a wrong
 * state.
 */
export function markResolved(md: string, item: AgendaItem, date: string): string {
  const lines = md.split(/\r?\n/)
  const idx = lines.indexOf(item.raw)
  if (idx === -1) return md
  lines[idx] = `- [x] done:${date} ${item.body}`
  return lines.join('\n')
}
