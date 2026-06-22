import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTestDb } from '../lib/db'
import { makeMessagesStore } from '../lib/messages-store'
import { importLocalHistory, LOCAL_CLAUDE_CHAT, LOCAL_CODEX_CHAT } from './local-import'

function writeClaudeSession(root: string, project: string, sessionId: string, turns: object[]): void {
  const dir = join(root, project)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${sessionId}.jsonl`), turns.map(t => JSON.stringify(t)).join('\n'))
}

function writeCodexRollout(root: string, y: string, m: string, d: string, file: string, lines: object[]): void {
  const dir = join(root, y, m, d)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, file), lines.map(l => JSON.stringify(l)).join('\n'))
}

const CLAUDE_TURNS = [
  { type: 'user', message: { content: 'hi from claude' }, timestamp: '2026-06-01T00:00:00.000Z' },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'claude reply' }] }, timestamp: '2026-06-01T00:00:01.000Z' },
]
const CODEX_LINES = [
  { type: 'response_item', timestamp: '2026-06-01T00:00:02.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi from codex' }] } },
]

describe('importLocalHistory', () => {
  it('imports claude + codex local history into local:* buckets and advances the watermark', async () => {
    const claudeRoot = mkdtempSync(join(tmpdir(), 'li-claude-'))
    const codexRoot = mkdtempSync(join(tmpdir(), 'li-codex-'))
    try {
      writeClaudeSession(claudeRoot, 'proj-a', 'sess1', CLAUDE_TURNS)
      writeCodexRollout(codexRoot, '2026', '06', '01', 'rollout-2026-06-01T00-00-00-abc.jsonl', CODEX_LINES)
      const db = openTestDb()
      let wm: number | null = null
      const result = await importLocalHistory({
        db, claudeProjectsRoot: claudeRoot, codexRoot,
        getWatermark: () => wm, setWatermark: (ms) => { wm = ms },
        now: () => 1_700_000_000_000,
      })
      expect(result.claude.inserted).toBeGreaterThan(0)
      expect(result.codex.inserted).toBeGreaterThan(0)
      const store = makeMessagesStore(db)
      const claudeMsgs = await store.listRange(LOCAL_CLAUDE_CHAT, { limit: 50 })
      const codexMsgs = await store.listRange(LOCAL_CODEX_CHAT, { limit: 50 })
      expect(claudeMsgs.some(m => m.text === 'hi from claude')).toBe(true)
      expect(claudeMsgs.some(m => m.text === 'claude reply')).toBe(true)
      expect(codexMsgs.some(m => m.text === 'hi from codex')).toBe(true)
      expect(wm).toBe(1_700_000_000_000) // watermark advanced to run-start
    } finally {
      rmSync(claudeRoot, { recursive: true, force: true })
      rmSync(codexRoot, { recursive: true, force: true })
    }
  })

  it('second run skips files untouched since the watermark (incremental, not just idempotent)', async () => {
    const claudeRoot = mkdtempSync(join(tmpdir(), 'li-claude2-'))
    const codexRoot = mkdtempSync(join(tmpdir(), 'li-codex2-'))
    try {
      writeClaudeSession(claudeRoot, 'proj-a', 'sess1', CLAUDE_TURNS)
      writeCodexRollout(codexRoot, '2026', '06', '01', 'rollout-2026-06-01T00-00-00-abc.jsonl', CODEX_LINES)
      const db = openTestDb()
      let wm: number | null = null
      // First run: watermark stamped in the FUTURE relative to the just-written
      // files' real mtime, so the next run's `since` is past their mtime.
      const future = Date.now() + 60_000
      const first = await importLocalHistory({
        db, claudeProjectsRoot: claudeRoot, codexRoot,
        getWatermark: () => wm, setWatermark: (ms) => { wm = ms }, now: () => future,
      })
      expect(first.claude.scanned).toBeGreaterThan(0)
      // Second run: since = future > file mtime → files SKIPPED (not even parsed).
      const second = await importLocalHistory({
        db, claudeProjectsRoot: claudeRoot, codexRoot,
        getWatermark: () => wm, setWatermark: (ms) => { wm = ms }, now: () => future + 1000,
      })
      expect(second.claude.scanned).toBe(0) // skipped by mtime, not re-parsed
      expect(second.codex.scanned).toBe(0)
    } finally {
      rmSync(claudeRoot, { recursive: true, force: true })
      rmSync(codexRoot, { recursive: true, force: true })
    }
  })

  it('missing roots are a clean no-op (no throw)', async () => {
    const db = openTestDb()
    let wm: number | null = null
    const result = await importLocalHistory({
      db, claudeProjectsRoot: '/no/such/claude', codexRoot: '/no/such/codex',
      getWatermark: () => wm, setWatermark: (ms) => { wm = ms }, now: () => 1_700_000_000_000,
    })
    expect(result).toEqual({ claude: { scanned: 0, inserted: 0 }, codex: { scanned: 0, inserted: 0 } })
    expect(wm).toBe(1_700_000_000_000)
  })
})
