import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PRESESSION_RECENT_MS } from '../../domain/presession'
import { discoverPresessions } from './presession'

const now = 1_800_000_000_000
let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'cc-presession-')) })
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

function fixture(path: string, lines: unknown[], mtime = now - 1000) {
  const file = join(home, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, lines.map(line => JSON.stringify(line)).join('\n'))
  utimesSync(file, mtime / 1000, mtime / 1000)
  return file
}
const claude = (id: string) => ({ type: 'user', sessionId: id, cwd: '/work/claude' })
const codex = (id: string) => ({ type: 'session_meta', payload: { id, cwd: '/work/codex' } })
function scan(log = vi.fn(), timeoutMs?: number) {
  return discoverPresessions({
    roots: { claudeProjectsRoot: join(home, '.claude/projects'), codexRoot: join(home, '.codex/sessions') },
    registered: new Set(['known']), now: () => now, log, ...(timeoutMs === undefined ? {} : { timeoutMs }),
  })
}

it('从两种记录读身份和尾部，跳过旧文件、登记过的会话、明确结束以及子会话', async () => {
  const big = 'x'.repeat(100_000)
  const a = fixture('.claude/projects/work/a.jsonl', [claude('claude-live'), { type: 'assistant', text: big }])
  const b = fixture('.codex/sessions/2026/11/26/rollout-new.jsonl', [
    codex('codex-live'), big, { type: 'event_msg', payload: { type: 'task_complete' } },
  ])
  fixture('.claude/projects/work/closed.jsonl', [claude('claude-ended'), big, { type: 'system', subtype: 'session_end' }])
  fixture('.codex/sessions/2026/11/26/rollout-ended.jsonl', [codex('codex-ended'), big, { type: 'event_msg', payload: { type: 'session_end' } }])
  fixture('.claude/projects/work/known.jsonl', [claude('known')])
  fixture('.claude/projects/work/old.jsonl', [claude('old')], now - PRESESSION_RECENT_MS - 1000)
  fixture('.claude/projects/work/no-cwd.jsonl', [{ type: 'user', sessionId: 'no-cwd' }])
  fixture('.claude/projects/work/no-id.jsonl', [{ type: 'user', cwd: '/work' }])
  fixture('.claude/projects/work/a/subagents/agent.jsonl', [claude('subagent')])

  const log = vi.fn()
  expect(await scan(log)).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: a, sessionId: 'claude-live', cwd: '/work/claude', source: 'claude' }),
    expect.objectContaining({ path: b, sessionId: 'codex-live', cwd: '/work/codex', source: 'codex' }),
  ]))
  expect(await scan(log)).toHaveLength(2)
  expect(log).not.toHaveBeenCalled()
})

it('到时停止并只记一行，根目录读不出来也只记一行', async () => {
  for (let i = 0; i < 20; i++) fixture(`.claude/projects/work/${i}.jsonl`, [claude(String(i))])
  const timeout = vi.fn()
  await scan(timeout, 0)
  expect(timeout).toHaveBeenCalledExactlyOnceWith('scan incomplete: timeout=true unreadable=0')
  fixture('.codex/sessions', [])
  const log = vi.fn()
  await scan(log)
  expect(log).toHaveBeenCalledExactlyOnceWith('scan incomplete: timeout=false unreadable=1')
})
