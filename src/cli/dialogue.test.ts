import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openTestDb } from '../lib/db'
import { backfillFromClaudeJsonl, claudeTurnToMessages, backfillFromCodexJsonl } from './dialogue'

describe('dialogue backfill', () => {
  it('claudeTurnToMessages maps user/assistant turns to in/out records', () => {
    const recs = claudeTurnToMessages(
      { type: 'user', ts: '2026-06-01T00:00:00Z', text: '你好' },
      'chat1', 'sess1', 0,
    )
    expect(recs[0]).toMatchObject({ chatId: 'chat1', direction: 'in', text: '你好', source: 'backfill:claude', id: 'bf:claude:sess1:0' })
  })

  it('claudeTurnToMessages maps assistant turns to out with provider=claude', () => {
    const recs = claudeTurnToMessages(
      { type: 'assistant', ts: '2026-06-01T00:00:05Z', text: '你好啊' },
      'chat1', 'sess1', 1,
    )
    expect(recs[0]).toMatchObject({ chatId: 'chat1', direction: 'out', text: '你好啊', source: 'backfill:claude', provider: 'claude' })
  })

  it('backfill is idempotent — second run adds nothing', async () => {
    const db = openTestDb()
    const dir = mkdtempSync(join(tmpdir(), 'bf-'))
    writeFileSync(join(dir, 's1.jsonl'), [
      JSON.stringify({ type: 'user', message: { content: '第一句' }, timestamp: '2026-06-01T00:00:00Z' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '回复' }] }, timestamp: '2026-06-01T00:00:05Z' }),
    ].join('\n'))
    const r1 = await backfillFromClaudeJsonl(db, dir, 'chat1')
    const r2 = await backfillFromClaudeJsonl(db, dir, 'chat1')
    expect(r1.inserted).toBe(2)
    expect(r2.inserted).toBe(0)
    expect(db.query('SELECT COUNT(*) c FROM messages').get()).toEqual({ c: 2 })
  })

  it('backfill dry-run: scans but does not write', async () => {
    const db = openTestDb()
    const dir = mkdtempSync(join(tmpdir(), 'bf-dry-'))
    writeFileSync(join(dir, 's1.jsonl'), [
      JSON.stringify({ type: 'user', message: { content: 'hello' }, timestamp: '2026-06-01T00:00:00Z' }),
    ].join('\n'))
    const r = await backfillFromClaudeJsonl(db, dir, 'chat1', true)
    expect(r.scanned).toBe(1)
    expect(r.inserted).toBe(0)
    expect(db.query('SELECT COUNT(*) c FROM messages').get()).toEqual({ c: 0 })
  })

  it('backfill skips lines with missing timestamp', async () => {
    const db = openTestDb()
    const dir = mkdtempSync(join(tmpdir(), 'bf-skip-'))
    writeFileSync(join(dir, 's1.jsonl'), [
      JSON.stringify({ type: 'user', message: { content: 'hello' } }), // no timestamp — skip
      JSON.stringify({ type: 'user', message: { content: 'world' }, timestamp: '2026-06-01T00:00:01Z' }),
    ].join('\n'))
    const r = await backfillFromClaudeJsonl(db, dir, 'chat1')
    expect(r.scanned).toBe(1)
    expect(r.inserted).toBe(1)
  })

  it('backfillFromCodexJsonl maps codex turns correctly and uses envelope timestamps', async () => {
    const db = openTestDb()
    // Build a fake codex root: <root>/YYYY/MM/DD/rollout-<ts>-<id>.jsonl
    const root = mkdtempSync(join(tmpdir(), 'codex-'))
    const dayDir = join(root, '2026', '06', '01')
    mkdirSync(dayDir, { recursive: true })
    const rolloutPath = join(dayDir, 'rollout-2026-06-01T10-00-00-abc123.jsonl')
    writeFileSync(rolloutPath, [
      JSON.stringify({ timestamp: '2026-06-01T10:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '你好 codex' }] } }),
      JSON.stringify({ timestamp: '2026-06-01T10:00:05.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '回复来自 codex' }] } }),
      JSON.stringify({ type: 'session_meta', payload: {} }), // should be skipped
    ].join('\n'))
    const r = await backfillFromCodexJsonl(db, root, 'chat1')
    expect(r.scanned).toBe(2)
    expect(r.inserted).toBe(2)
    const rows = db.query<{ direction: string; text: string; ts: string; provider: string | null; source: string }, []>(
      'SELECT direction, text, ts, provider, source FROM messages ORDER BY ts ASC'
    ).all()
    expect(rows[0]).toMatchObject({ direction: 'in', text: '你好 codex', ts: '2026-06-01T10:00:01.000Z', source: 'backfill:codex' })
    expect(rows[1]).toMatchObject({ direction: 'out', text: '回复来自 codex', ts: '2026-06-01T10:00:05.000Z', provider: 'codex', source: 'backfill:codex' })
  })

  it('backfillFromCodexJsonl uses filename-anchor fallback when envelope has no timestamp', async () => {
    const db = openTestDb()
    const root = mkdtempSync(join(tmpdir(), 'codex-anchor-'))
    const dayDir = join(root, '2025', '11', '25')
    mkdirSync(dayDir, { recursive: true })
    // Filename encodes 2025-11-25T02:41:55; lines have NO envelope timestamp
    writeFileSync(join(dayDir, 'rollout-2025-11-25T02-41-55-def999.jsonl'), [
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'anchor test' }] } }),
    ].join('\n'))
    const r = await backfillFromCodexJsonl(db, root, 'chat2')
    expect(r.scanned).toBe(1)
    expect(r.inserted).toBe(1)
    const row = db.query<{ ts: string }, []>('SELECT ts FROM messages').get()!
    // ts should be derived from the filename anchor 2025-11-25T02:41:55Z (+ 1ms for idx=1)
    expect(row.ts).toMatch(/^2025-11-25T02:41:55/)
  })

  it('backfillFromCodexJsonl skips turns with no timestamp source (neither envelope nor filename anchor)', async () => {
    const db = openTestDb()
    const root = mkdtempSync(join(tmpdir(), 'codex-nots-'))
    const dayDir = join(root, '2026', '06', '01')
    mkdirSync(dayDir, { recursive: true })
    // Filename has no parseable timestamp pattern; lines also have no envelope timestamp.
    // The turn is counted as scanned (text passes the empty guard) but not inserted.
    writeFileSync(join(dayDir, 'rollout-1234567890-abc123.jsonl'), [
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'no ts' }] } }),
    ].join('\n'))
    const r = await backfillFromCodexJsonl(db, root, 'chat3')
    expect(r.scanned).toBe(1)
    expect(r.inserted).toBe(0)
    expect(db.query('SELECT COUNT(*) c FROM messages').get()).toEqual({ c: 0 })
  })

  it('backfillFromCodexJsonl is idempotent', async () => {
    const db = openTestDb()
    const root = mkdtempSync(join(tmpdir(), 'codex-idem-'))
    const dayDir = join(root, '2026', '06', '01')
    mkdirSync(dayDir, { recursive: true })
    writeFileSync(join(dayDir, 'rollout-2026-06-01T00-00-00-def456.jsonl'), [
      JSON.stringify({ timestamp: '2026-06-01T00:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'repeat' }] } }),
    ].join('\n'))
    const r1 = await backfillFromCodexJsonl(db, root, 'chat1')
    const r2 = await backfillFromCodexJsonl(db, root, 'chat1')
    expect(r1.inserted).toBe(1)
    expect(r2.inserted).toBe(0)
    expect(db.query('SELECT COUNT(*) c FROM messages').get()).toEqual({ c: 1 })
  })

  it('backfillFromCodexJsonl handles missing root gracefully', async () => {
    const db = openTestDb()
    const r = await backfillFromCodexJsonl(db, '/tmp/__nonexistent_codex_root__', 'chat1')
    expect(r.scanned).toBe(0)
    expect(r.inserted).toBe(0)
  })
})
