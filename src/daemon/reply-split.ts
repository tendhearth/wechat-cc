/**
 * reply-split — pure splitting of an outbound reply into 2-3 human-feeling
 * WeChat bubbles (活人感, Phase 1b). No LLM, no I/O; boundaries are paragraph
 * breaks then sentence terminators 。！？!? and newlines — NEVER a bare '.'
 * (URLs / decimals / file paths stay intact). Fenced code blocks are atomic.
 * See docs/superpowers/specs/2026-07-09-reply-splitting-design.md.
 */

export interface SplitOpts {
  maxChunks?: number
  minLen?: number
}

/** Pacing between chunks: loosely simulates typing. */
export function paceMs(chunk: string): number {
  return Math.min(2000, Math.max(600, chunk.length * 30))
}

const MIN_CHUNK_VISIBLE = 10

export function splitReply(text: string, opts?: SplitOpts): string[] {
  const maxChunks = Math.max(1, opts?.maxChunks ?? 3)
  const minLen = opts?.minLen ?? 100
  if (maxChunks === 1 || text.length < minLen) return [text]

  // ── units over [start,end) ranges of the ORIGINAL string (verbatim chunks) ──
  type Unit = { start: number; end: number; atomic: boolean }
  const units: Unit[] = []
  const pushPlainParagraphs = (s: number, e: number): void => {
    const slice = text.slice(s, e)
    let last = 0
    for (const m of slice.matchAll(/\n[ \t]*\n+/g)) {
      if (m.index! > last) units.push({ start: s + last, end: s + m.index!, atomic: false })
      last = m.index! + m[0].length
    }
    if (last < slice.length) units.push({ start: s + last, end: s + slice.length, atomic: false })
  }
  // Fenced code blocks are atomic; an unterminated fence swallows to the end.
  let cursor = 0
  for (const m of text.matchAll(/```[\s\S]*?(?:```|$)/g)) {
    if (m.index! > cursor) pushPlainParagraphs(cursor, m.index!)
    units.push({ start: m.index!, end: m.index! + m[0].length, atomic: true })
    cursor = m.index! + m[0].length
  }
  if (cursor < text.length) pushPlainParagraphs(cursor, text.length)

  // No paragraph structure → refine the single plain unit at sentence bounds.
  if (units.length < 2) {
    const only = units[0]
    if (!only || only.atomic) return [text]
    const refined: Unit[] = []
    const slice = text.slice(only.start, only.end)
    let last = 0
    for (const m of slice.matchAll(/[。！？!?]+|\n/g)) {
      const cut = m[0] === '\n' ? m.index! : m.index! + m[0].length
      if (cut > last) refined.push({ start: only.start + last, end: only.start + cut, atomic: false })
      last = m.index! + m[0].length
    }
    if (last < slice.length) refined.push({ start: only.start + last, end: only.start + slice.length, atomic: false })
    if (refined.length < 2) return [text]
    units.length = 0
    units.push(...refined)
  }

  // ── greedy pack into ≤ maxChunks, roughly even by length ──
  const target = Math.ceil(text.length / maxChunks)
  const ranges: { start: number; end: number }[] = []
  let curStart = units[0]!.start
  let curLen = 0
  for (let i = 0; i < units.length; i++) {
    const u = units[i]!
    curLen += u.end - u.start
    const isLast = i === units.length - 1
    if (isLast || (curLen >= target && ranges.length < maxChunks - 1)) {
      ranges.push({ start: curStart, end: u.end })
      if (!isLast) { curStart = units[i + 1]!.start; curLen = 0 }
    }
  }

  // Merge tiny chunks into the previous one (no 3-char bubbles).
  const merged: { start: number; end: number }[] = []
  for (const r of ranges) {
    if (text.slice(r.start, r.end).trim().length < MIN_CHUNK_VISIBLE && merged.length > 0) {
      merged[merged.length - 1]!.end = r.end
    } else {
      merged.push({ ...r })
    }
  }

  if (merged.length < 2) return [text]
  return merged.map(r => text.slice(r.start, r.end).trim()).filter(c => c.length > 0)
}
