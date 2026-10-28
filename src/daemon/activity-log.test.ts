import { describe, expect, it, vi } from 'vitest'
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeActivityLog, ACTIVITY_LOG_FILE, ACTIVITY_LOG_MAX_LINES } from './activity-log'

const dir = () => mkdtempSync(join(tmpdir(), 'act-'))
const NOW = Date.parse('2026-10-20T12:00:00Z')

describe('activity-log', () => {
  it('appends asynchronously; only kind/status/ref (+ public facts), never free text', async () => {
    const d = dir()
    const log = makeActivityLog({ stateDir: d, now: () => NOW, log: () => {} })
    log.append({ kind: 'job', status: 'sent', ref: 'j2' })
    log.append({ kind: 'proactive', status: 'deferred' })
    log.append({ kind: 'cli_upgrade', status: 'ok', facts: { cli: 'codex', from: '0.159.0', to: '0.160.0' } })
    expect(log.read(0)).toEqual([])          // 还没落盘:不在调用方的热路径上
    await log.flush()
    const rows = log.read(0)
    expect(rows.map(r => r.kind)).toEqual(['job', 'proactive', 'cli_upgrade'])
    expect(rows[0]).toEqual({ at: NOW, kind: 'job', status: 'sent', ref: 'j2' })
    expect(Object.keys(rows[1]!)).not.toContain('text')
  })
  it('rejects free-text-ish facts (only short tokens survive)', async () => {
    const d = dir()
    const log = makeActivityLog({ stateDir: d, now: () => NOW, log: () => {} })
    log.append({ kind: 'cli_upgrade', status: 'ok', facts: { cli: 'codex', note: '这是一大段可能是正文的话,不该进日志' } as never })
    await log.flush()
    expect(log.read(0)[0]!.facts).toEqual({ cli: 'codex' })
  })
  it('write failure never throws to the caller; it is logged once', async () => {
    const msgs: string[] = []
    const log = makeActivityLog({ stateDir: '/dev/null/nope', now: () => NOW, log: (_t, l) => msgs.push(l) })
    expect(() => log.append({ kind: 'job', status: 'sent', ref: 'j1' })).not.toThrow()
    await log.flush()
    expect(msgs.some(m => m.includes('append failed'))).toBe(true)
  })
  it('bad lines are skipped; read(since) filters by time', async () => {
    const d = dir()
    writeFileSync(join(d, ACTIVITY_LOG_FILE), `{"at":${NOW - 5000},"kind":"job","status":"sent","ref":"j1"}\nnot json\n{"at":"x"}\n{"at":${NOW},"kind":"reminder","status":"sent","ref":"r9"}\n`)
    const log = makeActivityLog({ stateDir: d, now: () => NOW, log: () => {} })
    expect(log.read(0).map(r => r.ref)).toEqual(['j1', 'r9'])
    expect(log.read(NOW - 1000).map(r => r.ref)).toEqual(['r9'])
  })
  it('stays bounded: over the line cap ⇒ keeps the newer half; entries older than 14 days are dropped', async () => {
    const d = dir()
    const f = join(d, ACTIVITY_LOG_FILE)
    const lines = Array.from({ length: ACTIVITY_LOG_MAX_LINES + 10 }, (_, i) => JSON.stringify({ at: NOW - (ACTIVITY_LOG_MAX_LINES + 10 - i) * 1000, kind: 'job', status: 'sent', ref: `j${i}` })).join('\n') + '\n'
    writeFileSync(f, JSON.stringify({ at: NOW - 15 * 86_400_000, kind: 'job', status: 'sent', ref: 'ancient' }) + '\n' + lines)
    const log = makeActivityLog({ stateDir: d, now: () => NOW, log: () => {} })
    log.append({ kind: 'job', status: 'sent', ref: 'new' })
    await log.flush()
    const kept = readFileSync(f, 'utf8').trim().split('\n')
    expect(kept.length).toBeLessThanOrEqual(ACTIVITY_LOG_MAX_LINES / 2 + 1)
    expect(kept.at(-1)).toContain('"new"')
    expect(readFileSync(f, 'utf8')).not.toContain('ancient')
    void appendFileSync
  })
})

describe('activity-log · status', () => {
  it('non-code statuses become other (no reason text sneaks in)', async () => {
    const d = mkdtempSync(join(tmpdir(), 'act-'))
    const log = makeActivityLog({ stateDir: d, now: () => NOW, log: () => {} })
    log.append({ kind: 'job', status: 'failed:OpenAI said rate limited', ref: 'j1' })
    log.append({ kind: 'job', status: 'skipped:cap', ref: 'j1' })
    await log.flush()
    expect(log.read(0).map(r => r.status)).toEqual(['other', 'skipped:cap'])
  })
})
