/**
 * dialogue.ts — backfill CLI helpers.
 *
 * Imports conversation history from agent session JSONLs into the `messages`
 * SQLite table. Two sources are supported:
 *
 *   1. Claude session JSONLs: ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
 *      Shape: { type: 'user'|'assistant', message: { content }, timestamp }
 *      Walker: given a directory of *.jsonl files (produced by caller from
 *      resolveProjectJsonlPath or a test tmpdir), parse each line.
 *
 *   2. Codex rollout JSONLs: ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<id>.jsonl
 *      Conversion via readCodexJsonlAsClaudeTurns from codex-jsonl.ts.
 *      Walker: recursive depth-3 scan (year/month/day) for rollout-*.jsonl.
 *
 * Implementation note: the existing `sessions read-jsonl` CLI command in
 * cli.ts uses the same JSON shape for claude JSONLs (line-by-line JSON.parse),
 * but that parsing is inlined in the command run() and is not exported. This
 * module reimplements the parser standalone — kept intentionally minimal so
 * it can be unit-tested without the full sessions machinery.
 *
 * The codex path reuses readCodexJsonlAsClaudeTurns (already exported) to
 * avoid duplicating the codec logic.
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Db } from '../lib/db'
import { makeMessagesStore, type MessageRecord } from '../daemon/messages/store'

// ── Types ─────────────────────────────────────────────────────────────

export interface SimpleTurn {
  type: 'user' | 'assistant'
  ts: string
  text: string
}

// ── claude JSONL parser ───────────────────────────────────────────────

/**
 * Parse one line from a claude session JSONL.
 * Returns null for lines that don't carry displayable text (tool calls,
 * summary entries, lines with missing timestamp, etc.).
 */
function parseClaudeJsonlLine(line: string): SimpleTurn | null {
  try {
    const o = JSON.parse(line) as Record<string, unknown>
    const ts = typeof o.timestamp === 'string' ? o.timestamp : null
    if (!ts) return null
    if (o.type === 'user') {
      const m = o.message as { content?: unknown } | undefined
      const text = typeof m?.content === 'string' ? m.content : null
      return text ? { type: 'user', ts, text } : null
    }
    if (o.type === 'assistant') {
      const m = o.message as { content?: Array<{ type: string; text?: string }> } | undefined
      const text = (m?.content ?? [])
        .filter(b => b.type === 'text')
        .map(b => b.text ?? '')
        .join('\n')
      return text ? { type: 'assistant', ts, text } : null
    }
    return null
  } catch {
    return null
  }
}

// ── Public helpers ────────────────────────────────────────────────────

/**
 * Map one SimpleTurn to MessageRecord[]. The idx parameter is the line
 * position counter and is baked into the record id — it must be stable
 * across reruns (the same position always produces the same id).
 */
export function claudeTurnToMessages(
  turn: SimpleTurn,
  chatId: string,
  sessionKey: string,
  idx: number,
): MessageRecord[] {
  return [
    {
      id: `bf:claude:${sessionKey}:${idx}`,
      chatId,
      ts: turn.ts,
      direction: turn.type === 'user' ? 'in' : 'out',
      kind: 'text',
      text: turn.text,
      ...(turn.type === 'assistant' ? { provider: 'claude' } : {}),
      source: 'backfill:claude',
    },
  ]
}

/**
 * Import all *.jsonl files in `dir` into the messages table, attributing
 * them to `chatId`. Uses INSERT OR IGNORE so reruns are safe.
 *
 * @param dryRun When true, parse and count but write nothing.
 */
export async function backfillFromClaudeJsonl(
  db: Db,
  dir: string,
  chatId: string,
  dryRun = false,
): Promise<{ scanned: number; inserted: number }> {
  const store = makeMessagesStore(db)
  let scanned = 0
  let inserted = 0

  let files: string[]
  try {
    files = readdirSync(dir).filter(f => f.endsWith('.jsonl'))
  } catch {
    return { scanned, inserted }
  }

  for (const f of files) {
    const sessionKey = f.replace(/\.jsonl$/, '')
    const lines = readFileSync(join(dir, f), 'utf8')
      .split('\n')
      .filter(Boolean)
    let idx = 0
    for (const line of lines) {
      idx++
      const turn = parseClaudeJsonlLine(line)
      if (!turn) continue
      scanned++
      if (dryRun) continue
      const before = db.query<{ c: number }, []>('SELECT COUNT(*) c FROM messages').get()!.c
      for (const rec of claudeTurnToMessages(turn, chatId, sessionKey, idx)) {
        await store.append(rec)
      }
      const after = db.query<{ c: number }, []>('SELECT COUNT(*) c FROM messages').get()!.c
      inserted += after - before
    }
  }
  return { scanned, inserted }
}

// ── Codex path ────────────────────────────────────────────────────────

/**
 * Walk `codexRoot` (depth 3: year/month/day) for rollout-*.jsonl files,
 * convert each via readCodexJsonlAsClaudeTurns, and import into the
 * messages table with source='backfill:codex'. Idempotent (INSERT OR IGNORE).
 *
 * @param dryRun When true, parse and count but write nothing.
 */
export async function backfillFromCodexJsonl(
  db: Db,
  codexRoot: string,
  chatId: string,
  dryRun = false,
): Promise<{ scanned: number; inserted: number }> {
  const { readCodexJsonlAsClaudeTurns } = await import('../daemon/sessions/codex-jsonl')
  const store = makeMessagesStore(db)
  let scanned = 0
  let inserted = 0

  if (!existsSync(codexRoot)) return { scanned, inserted }

  // Walk year/month/day (depth ≤ 3, mirrors findCodexRollout layout)
  const rollouts: string[] = []
  try {
    for (const year of safeReaddir(codexRoot)) {
      const yearDir = join(codexRoot, year)
      if (!isDir(yearDir)) continue
      for (const month of safeReaddir(yearDir)) {
        const monthDir = join(yearDir, month)
        if (!isDir(monthDir)) continue
        for (const day of safeReaddir(monthDir)) {
          const dayDir = join(monthDir, day)
          if (!isDir(dayDir)) continue
          for (const file of safeReaddir(dayDir)) {
            if (file.startsWith('rollout-') && file.endsWith('.jsonl')) {
              rollouts.push(join(dayDir, file))
            }
          }
        }
      }
    }
  } catch { /* fall through — partial results fine */ }

  for (const rolloutPath of rollouts) {
    // Use the file basename (without extension) as the stable session key
    const basename = rolloutPath.split('/').pop()!.replace(/\.jsonl$/, '')
    const turns = readCodexJsonlAsClaudeTurns(rolloutPath)
    let idx = 0
    for (const turn of turns) {
      idx++
      scanned++
      if (dryRun) continue
      // Build a MessageRecord from the claude-shaped turn.
      // Codex turns have no timestamp in the ClaudeShapeTurn shape, so we
      // use a synthetic ts based on idx (stable across reruns). The ts only
      // needs to be consistent — it's not displayed as wall-clock time.
      const text = turn.message.content.map(b => b.text).join('\n')
      if (!text) continue
      const rec: MessageRecord = {
        id: `bf:codex:${basename}:${idx}`,
        chatId,
        ts: `0001-01-01T00:00:00.${String(idx).padStart(6, '0')}Z`, // stable synthetic ts
        direction: turn.type === 'user' ? 'in' : 'out',
        kind: 'text',
        text,
        ...(turn.type === 'assistant' ? { provider: 'codex' } : {}),
        source: 'backfill:codex',
      }
      const before = db.query<{ c: number }, []>('SELECT COUNT(*) c FROM messages').get()!.c
      await store.append(rec)
      const after = db.query<{ c: number }, []>('SELECT COUNT(*) c FROM messages').get()!.c
      inserted += after - before
    }
  }
  return { scanned, inserted }
}

// ── Private helpers ───────────────────────────────────────────────────

function safeReaddir(p: string): string[] {
  try {
    return readdirSync(p)
  } catch {
    return []
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}
