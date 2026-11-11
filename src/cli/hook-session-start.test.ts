import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sessionStartOutput } from './hook-session-start'

const dirs: string[] = []
afterEach(() => { vi.useRealTimers(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
function state() {
  const d = mkdtempSync(join(tmpdir(), 'cc-session-start-')); dirs.push(d)
  writeFileSync(join(d, 'token'), 'test-token')
  writeFileSync(join(d, 'internal-api-info.json'), JSON.stringify({ baseUrl: 'http://127.0.0.1:1', tokenFilePath: join(d, 'token') }))
  return d
}
const raw = { hook_event_name: 'SessionStart', session_id: 'sess-1', cwd: '/project', source: 'startup' }

describe('native SessionStart output', () => {
  it.each(['claude', 'codex'] as const)('%s sends FILE auth and emits a single additionalContext object', async source => {
    const fetchImpl = (async (url: string, opts: RequestInit) => {
      expect(url).toBe('http://127.0.0.1:1/v1/cli/project-memory')
      expect(opts.headers).toMatchObject({ authorization: 'Bearer test-token' })
      expect(JSON.parse(opts.body as string)).toEqual({ source, session_id: 'sess-1', cwd: '/project' })
      return Response.json({ context: '项目近况' })
    }) as unknown as typeof fetch
    expect(JSON.parse(await sessionStartOutput(state(), source, raw, { fetchImpl }))).toEqual({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '项目近况' } })
  })
  it('empty, bad, oversized and failed responses emit nothing', async () => {
    for (const response of [Response.json({ context: '' }), Response.json({ context: 'x'.repeat(1201) }), Response.json({ context: 1 }), new Response('bad'), new Response('', { status: 503 })]) {
      expect(await sessionStartOutput(state(), 'claude', raw, { fetchImpl: (async () => response) as unknown as typeof fetch })).toBe('')
    }
    expect(await sessionStartOutput(state(), 'claude', raw, { fetchImpl: (async () => { throw new Error('offline') }) as unknown as typeof fetch })).toBe('')
    expect(await sessionStartOutput('/missing-cc-state', 'claude', raw)).toBe('')
  })
  it('deadline covers the response body as well as fetch, including a fetch that ignores abort', async () => {
    const start = performance.now()
    const stalledBody = (async () => new Response(new ReadableStream({ start() {} }))) as unknown as typeof fetch
    expect(await sessionStartOutput(state(), 'claude', raw, { timeoutMs: 20, fetchImpl: stalledBody })).toBe('')
    expect(await sessionStartOutput(state(), 'claude', raw, { timeoutMs: 20, fetchImpl: (() => new Promise(() => {})) as unknown as typeof fetch })).toBe('')
    expect(performance.now() - start).toBeLessThan(1000)
  })
  it('does not restart the request deadline after synchronous setup stalls the event loop', async () => {
    vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] })
    const fetchImpl = (() => {
      vi.advanceTimersByTime(30)
      return Promise.resolve(Response.json({ context: 'too late' }))
    }) as unknown as typeof fetch
    expect(await sessionStartOutput(state(), 'claude', raw, { timeoutMs: 20, fetchImpl })).toBe('')
  })
  it('does not fetch after the absolute stdin deadline has already elapsed', async () => {
    let requests = 0
    const fetchImpl = (async () => { requests++; return Response.json({ context: 'too late' }) }) as unknown as typeof fetch
    expect(await sessionStartOutput(state(), 'claude', raw, { deadlineAt: performance.now() - 1, fetchImpl })).toBe('')
    expect(requests).toBe(0)
  })
  it('child agent, malformed input, cursor and daemon children never fetch', async () => {
    const fetchImpl = (() => { throw new Error('must not call') }) as unknown as typeof fetch
    for (const input of [null, {}, { ...raw, agent_id: 'sub' }, { ...raw, cwd: '' }, { ...raw, hook_event_name: 'Stop' }]) {
      expect(await sessionStartOutput(state(), 'claude', input, { fetchImpl })).toBe('')
    }
    expect(await sessionStartOutput(state(), 'cursor', raw, { fetchImpl })).toBe('')
    expect(await sessionStartOutput(state(), 'codex', raw, { fetchImpl, env: { WECHAT_CC_DAEMON_CHILD: '1' } })).toBe('')
  })
})
