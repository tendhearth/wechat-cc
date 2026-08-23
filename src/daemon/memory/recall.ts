/**
 * Own-memory recall — the non-admin lane of auto-recall (mw-recall). A
 * guest/trusted chat must never touch the knowledge kernel (owner-private),
 * but its OWN memory/<chatId>/*.md files are exactly its scope — the same
 * subtree memory_read already grants it. Deterministic keyword scoring, no
 * LLM, no embeddings: at .md-note scale ripgrep-style matching is enough
 * (the hearth lesson — resist the urge to make it smarter).
 *
 * profile.md and knowledge.md are excluded because prompt-builder already
 * injects them EVERY turn (core/knowledge memory sections) — recalling them
 * again would only duplicate context.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeMemoryFS } from './fs-api'

const EXCLUDED = new Set(['profile.md', 'knowledge.md'])
const MAX_FILES = 30
const LINE_SNIPPET_MAX = 160

/** Query tokens: lowercase latin words (≥2 chars) + CJK bigrams. */
function tokenize(q: string): string[] {
  const out = new Set<string>()
  for (const m of q.toLowerCase().matchAll(/[a-z0-9_]{2,}/g)) out.add(m[0])
  const cjk = q.match(/[一-鿿]+/g) ?? []
  for (const run of cjk) {
    if (run.length === 1) out.add(run)
    for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2))
  }
  return [...out]
}

export function recallFromMemory(
  stateDir: string,
  chatId: string,
  query: string,
  limit = 3,
): string[] {
  // Same chatId-shape guard as main.ts's personaFor — the id feeds a path join.
  if (chatId.includes('..') || chatId.includes('/') || chatId.includes('\\')) return []
  const root = join(stateDir, 'memory', chatId)
  if (!existsSync(root)) return []

  const tokens = tokenize(query)
  if (tokens.length === 0) return []
  // Short queries must match most of their tokens; long ones a third.
  const needed = Math.max(2, Math.ceil(tokens.length / 3))

  let files: string[]
  try {
    files = makeMemoryFS({ rootDir: root }).list().filter((f) => !EXCLUDED.has(f)).slice(0, MAX_FILES)
  } catch {
    return []
  }

  const scored: Array<{ file: string; line: string; hits: number }> = []
  for (const file of files) {
    let content: string
    try {
      content = readFileSync(join(root, file), 'utf8')
    } catch {
      continue
    }
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim()
      if (line.length < 2) continue
      const lower = line.toLowerCase()
      let hits = 0
      for (const t of tokens) if (lower.includes(t)) hits++
      if (hits >= needed) scored.push({ file, line, hits })
    }
  }

  scored.sort((a, b) => b.hits - a.hits)
  return scored.slice(0, limit).map((s) => `[${s.file}] ${s.line.slice(0, LINE_SNIPPET_MAX)}`)
}
