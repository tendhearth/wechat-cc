import { describe, it, expect } from 'vitest'
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatHumanLine, formatJsonRecord, maybeCopyTruncate } from './log'

describe('formatHumanLine', () => {
  it('builds the legacy `<ISO> [TAG] <msg>` shape parsed by src/cli/logs.ts', () => {
    const line = formatHumanLine('2026-05-02T07:00:00.000Z', 'BOOT', 'started pid=42')
    expect(line).toBe('2026-05-02T07:00:00.000Z [BOOT] started pid=42\n')
  })

  it('preserves message content verbatim (no escaping)', () => {
    const line = formatHumanLine('2026-05-02T07:00:00.000Z', 'TEST', 'has "quotes" and a / slash')
    expect(line).toBe('2026-05-02T07:00:00.000Z [TEST] has "quotes" and a / slash\n')
  })
})

describe('formatJsonRecord', () => {
  it('emits one JSON object per line with ts/tag/msg + fields merged', () => {
    const line = formatJsonRecord('2026-05-02T07:00:00.000Z', 'COORDINATOR', 'solo dispatch', {
      event: 'dispatch_solo',
      chat_id: 'c1',
      provider: 'claude',
    })
    expect(line).not.toBeNull()
    expect(line!.endsWith('\n')).toBe(true)
    const parsed = JSON.parse(line!)
    expect(parsed).toEqual({
      ts: '2026-05-02T07:00:00.000Z',
      tag: 'COORDINATOR',
      msg: 'solo dispatch',
      event: 'dispatch_solo',
      chat_id: 'c1',
      provider: 'claude',
    })
  })

  it('field collision: caller-supplied keys win over the canonical set', () => {
    // Documented behaviour — caller can override `ts`/`tag`/`msg` if needed
    // (e.g. backfilling historical events). Spread order makes this explicit.
    const line = formatJsonRecord('2026-05-02T07:00:00.000Z', 'TAG', 'msg', { tag: 'OVERRIDDEN' })
    const parsed = JSON.parse(line!)
    expect(parsed.tag).toBe('OVERRIDDEN')
  })

  it('returns null on circular references (never crashes the caller)', () => {
    const circular: Record<string, unknown> = { name: 'x' }
    circular.self = circular
    const line = formatJsonRecord('2026-05-02T07:00:00.000Z', 'TAG', 'msg', circular)
    expect(line).toBeNull()
  })
})

describe('maybeCopyTruncate (launchd stdio logs)', () => {
  it('copies out and truncates in place; a writer holding an O_APPEND fd keeps writing at the new start', () => {
    const dir = mkdtempSync(join(tmpdir(), 'log-rot-'))
    try {
      const file = join(dir, 'launchd.err.log')
      // Simulates launchd: the writer's fd was opened before rotation, O_APPEND.
      const fd = openSync(file, 'a')
      writeSync(fd, 'x'.repeat(200))
      maybeCopyTruncate(file, 100)
      expect(readFileSync(`${file}.1`, 'utf8')).toBe('x'.repeat(200))
      writeSync(fd, 'after\n')
      closeSync(fd)
      // No sparse hole at the old offset: the live file holds only new lines.
      expect(statSync(file).size).toBe('after\n'.length)
      expect(readFileSync(file, 'utf8')).toBe('after\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps one older generation and leaves small files alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'log-rot-'))
    try {
      const file = join(dir, 'launchd.err.log')
      writeFileSync(file, 'a'.repeat(200))
      maybeCopyTruncate(file, 100)
      writeFileSync(file, 'b'.repeat(200))
      maybeCopyTruncate(file, 100)
      expect(readFileSync(`${file}.2`, 'utf8')).toBe('a'.repeat(200))
      expect(readFileSync(`${file}.1`, 'utf8')).toBe('b'.repeat(200))
      writeFileSync(file, 'small')
      maybeCopyTruncate(file, 100)
      expect(readFileSync(file, 'utf8')).toBe('small')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is a silent no-op when the file does not exist', () => {
    expect(() => maybeCopyTruncate(join(tmpdir(), 'no-such-dir-xyz', 'launchd.err.log'), 1)).not.toThrow()
  })
})
