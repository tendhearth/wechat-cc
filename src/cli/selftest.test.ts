import { describe, expect, it } from 'vitest'
import {
  formatSelftestReport,
  redSquarePng,
  runChatSelftest,
  runWorkbenchSelftest,
  SELFTEST_EXIT,
  type SelftestDeps,
  type SelftestReport,
} from './selftest'

// ── test scaffolding ───────────────────────────────────────────────

interface RecordedCall { method: string; path: string; body: any }

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response
}

function baseDeps(overrides: Partial<SelftestDeps> = {}): SelftestDeps {
  const files = new Map<string, string>()
  return {
    fetch: (async () => { throw new Error('fetch not stubbed for this test') }) as unknown as typeof fetch,
    readApiInfo: () => ({ baseUrl: 'http://127.0.0.1:9', token: 'file-token', operatorToken: 'op-token' }),
    stateDir: '/state',
    now: () => 1000,
    sleep: async () => {},
    fs: {
      mkdir: () => {},
      write: (p, text) => { files.set(p, typeof text === 'string' ? text : '<binary>') },
      read: (p) => files.get(p) ?? null,
      rm: (p) => { files.delete(p) },
    },
    git: () => true,
    log: () => {},
    ...overrides,
  }
}

/** Fake workbench API: dispatches on `${method} ${pathname}`, records every
 *  call's body, and returns `taskResponses[i]` for the i-th (clamped)
 *  `GET /v1/workbench/task` call — the "任务详情按调用次数返回递进状态"
 *  shape the brief asks for. */
function makeWorkbenchFakeApi(opts: { taskId?: string; taskResponses: unknown[]; createStatus?: number; createBody?: unknown }) {
  const calls: RecordedCall[] = []
  const taskId = opts.taskId ?? 'ab12cd34'
  let taskCallIdx = 0
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url))
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = init?.body ? JSON.parse(init.body as string) : undefined
    calls.push({ method, path: u.pathname, body })
    const key = `${method} ${u.pathname}`
    switch (key) {
      case 'POST /v1/workbench/attachment':
        return jsonResponse(200, { attachment: { id: body.id } })
      case 'POST /v1/workbench/create':
        return jsonResponse(opts.createStatus ?? 202, opts.createBody ?? { task: { id: taskId, status: 'queued', phase: 'queued', error: null } })
      case 'GET /v1/workbench/task': {
        const idx = Math.min(taskCallIdx, opts.taskResponses.length - 1)
        taskCallIdx++
        return jsonResponse(200, opts.taskResponses[idx])
      }
      case 'POST /v1/workbench/permission':
        return jsonResponse(200, { ok: true })
      case 'POST /v1/workbench/continue':
        return jsonResponse(202, { task: { id: taskId, status: 'running', phase: 'working', error: null } })
      case 'POST /v1/workbench/archive':
        return jsonResponse(200, { task: { id: taskId, archivedAt: 1 } })
      default:
        throw new Error(`unexpected fetch: ${key}`)
    }
  }) as unknown as typeof fetch
  return { fetchImpl, calls, taskId }
}

// ── redSquarePng ────────────────────────────────────────────────────

describe('redSquarePng', () => {
  it('produces a valid PNG: signature, size, and the three chunk types', () => {
    const png = redSquarePng()
    expect(png.length).toBeGreaterThan(100)
    expect(Array.from(png.slice(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const text = Buffer.from(png).toString('latin1')
    expect(text).toContain('IHDR')
    expect(text).toContain('IDAT')
    expect(text).toContain('IEND')
  })
})

// ── formatSelftestReport ────────────────────────────────────────────

describe('formatSelftestReport', () => {
  it('renders ✓/✗ lines with details, and PASS on an ok report', () => {
    const r: SelftestReport = {
      ok: true, kind: 'chat', target: 'claude', durationMs: 10,
      checks: [{ name: 'replied', ok: true, detail: '1 text(s)' }, { name: 'tool_seen', ok: true }],
    }
    const out = formatSelftestReport(r)
    expect(out).toContain('✓ replied — 1 text(s)')
    expect(out).toContain('✓ tool_seen')
    expect(out.trim().endsWith('PASS')).toBe(true)
  })
  it('renders FAIL and ✗ lines on a failing report', () => {
    const r: SelftestReport = { ok: false, kind: 'chat', target: 'claude', durationMs: 1, checks: [{ name: 'replied', ok: false, detail: 'timeout' }] }
    const out = formatSelftestReport(r)
    expect(out).toContain('✗ replied — timeout')
    expect(out.trim().endsWith('FAIL')).toBe(true)
  })
})

// ── SELFTEST_EXIT ────────────────────────────────────────────────────

it('SELFTEST_EXIT codes match spec: ok=0, failed=1, noDaemon=2', () => {
  expect(SELFTEST_EXIT).toEqual({ ok: 0, failed: 1, noDaemon: 2 })
})

// ── runWorkbenchSelftest ─────────────────────────────────────────────

describe('runWorkbenchSelftest', () => {
  it('success path: all checks pass, permission auto-allowed, archive + cleanup happen', async () => {
    const api = makeWorkbenchFakeApi({
      taskResponses: [
        {
          task: { id: 'ab12cd34', status: 'running', phase: 'working', error: null },
          events: [
            { id: 1, kind: 'user', text: 'go' },
            { id: 2, kind: 'tool_call', text: 'shell: uname -a', activity: { tool: 'shell' } },
          ],
          permissions: [{ id: 'perm-1', tool: 'shell', description: 'run uname -a' }],
          version: 3,
        },
        {
          task: { id: 'ab12cd34', status: 'completed', phase: 'replied', error: null },
          events: [{ id: 3, kind: 'text', text: 'Darwin ... done, wrote hello.txt' }],
          permissions: [],
          version: 6,
        },
      ],
    })
    const rmCalls: string[] = []
    const deps = baseDeps({
      fetch: api.fetchImpl,
      now: () => 5000,
      fs: {
        mkdir: () => {},
        write: () => {},
        read: (p) => (p.endsWith('/hello.txt') ? 'hello' : null),
        rm: (p) => { rmCalls.push(p) },
      },
    })

    const report = await runWorkbenchSelftest(deps, { executor: 'claude' })

    expect(report.kind).toBe('workbench')
    expect(report.target).toBe('claude')
    expect(report.taskId).toBe('ab12cd34')
    expect(report.ok).toBe(true)
    for (const name of ['created', 'replied', 'text_seen', 'activity_seen', 'permission_roundtrip', 'file_written', 'no_error_event']) {
      const check = report.checks.find((c) => c.name === name)
      expect(check, `missing check ${name}`).toBeDefined()
      expect(check!.ok, `check ${name} should be ok: ${check!.detail}`).toBe(true)
    }

    const createCall = api.calls.find((c) => c.method === 'POST' && c.path === '/v1/workbench/create')!
    expect(createCall.body.providerId).toBe('claude')
    expect(createCall.body.path).toBe('/state/selftest/wb-5000')

    const permCall = api.calls.find((c) => c.method === 'POST' && c.path === '/v1/workbench/permission')!
    expect(permCall.body).toEqual({ id: 'ab12cd34', requestId: 'perm-1', decision: 'allow' })

    expect(api.calls.some((c) => c.method === 'POST' && c.path === '/v1/workbench/archive' && c.body.id === 'ab12cd34' && c.body.archived === true)).toBe(true)
    expect(rmCalls).toContain('/state/selftest/wb-5000')
  })

  it('--image: uploads a PNG attachment, create carries draftId/attachmentIds, answer_mentions_red check', async () => {
    const api = makeWorkbenchFakeApi({
      taskId: 'bb22cc33',
      taskResponses: [
        {
          task: { id: 'bb22cc33', status: 'completed', phase: 'replied', error: null },
          events: [{ id: 1, kind: 'text', text: '图片里是红色方块' }],
          permissions: [],
          version: 2,
        },
      ],
    })
    const deps = baseDeps({ fetch: api.fetchImpl, now: () => 9000 })

    const report = await runWorkbenchSelftest(deps, { executor: 'cursor', image: true })

    expect(report.ok).toBe(true)
    const uploadCall = api.calls.find((c) => c.method === 'POST' && c.path === '/v1/workbench/attachment')!
    expect(uploadCall.body.mime).toBe('image/png')
    const decoded = Buffer.from(uploadCall.body.base64, 'base64')
    expect(Array.from(decoded.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

    const createCall = api.calls.find((c) => c.method === 'POST' && c.path === '/v1/workbench/create')!
    expect(createCall.body.draftId).toBe(uploadCall.body.draftId)
    expect(createCall.body.attachmentIds).toEqual([uploadCall.body.id])

    expect(report.checks.find((c) => c.name === 'answer_mentions_red')?.ok).toBe(true)
    expect(report.checks.some((c) => c.name === 'activity_seen')).toBe(false)
    expect(report.checks.some((c) => c.name === 'permission_roundtrip')).toBe(false)
    expect(report.checks.some((c) => c.name === 'file_written')).toBe(false)
  })

  it('--resume: continue is called and resume_replied passes on new text', async () => {
    const api = makeWorkbenchFakeApi({
      taskId: 'cc33dd44',
      taskResponses: [
        {
          task: { id: 'cc33dd44', status: 'completed', phase: 'replied', error: null },
          events: [
            { id: 1, kind: 'tool_call', text: 'shell: uname -a', activity: { tool: 'shell' } },
            { id: 2, kind: 'text', text: 'done, wrote hello.txt' },
          ],
          permissions: [{ id: 'perm-1', tool: 'shell', description: 'run uname -a' }],
          version: 5,
        },
        {
          task: { id: 'cc33dd44', status: 'completed', phase: 'replied', error: null },
          events: [{ id: 3, kind: 'text', text: '第一件事是运行 uname -a' }],
          permissions: [],
          version: 7,
        },
      ],
    })
    const deps = baseDeps({
      fetch: api.fetchImpl,
      now: () => 7000,
      fs: { mkdir: () => {}, write: () => {}, read: (p) => (p.endsWith('/hello.txt') ? 'hello' : null), rm: () => {} },
    })

    const report = await runWorkbenchSelftest(deps, { executor: 'claude', resume: true })

    expect(api.calls.some((c) => c.method === 'POST' && c.path === '/v1/workbench/continue' && c.body.id === 'cc33dd44')).toBe(true)
    expect(report.checks.find((c) => c.name === 'resume_replied')?.ok).toBe(true)
    expect(report.ok).toBe(true)
  })

  it('failed task: replied is ✗, overall ok is false, archive still runs', async () => {
    const api = makeWorkbenchFakeApi({
      taskId: 'ff112233',
      taskResponses: [
        {
          task: { id: 'ff112233', status: 'failed', phase: 'failed', error: 'boom' },
          events: [{ id: 1, kind: 'error', text: 'boom' }],
          permissions: [],
          version: 2,
        },
      ],
    })
    const deps = baseDeps({ fetch: api.fetchImpl })

    const report = await runWorkbenchSelftest(deps, { executor: 'claude' })

    expect(report.checks.find((c) => c.name === 'replied')?.ok).toBe(false)
    expect(report.ok).toBe(false)
    expect(api.calls.some((c) => c.method === 'POST' && c.path === '/v1/workbench/archive')).toBe(true)
  })

  it('daemon not running (readApiInfo → null) throws daemon_not_running', async () => {
    const deps = baseDeps({ readApiInfo: () => null })
    await expect(runWorkbenchSelftest(deps, { executor: 'claude' })).rejects.toThrow('daemon_not_running')
  })

  it('timeout: no terminal status reached before the deadline ⇒ replied ✗ with detail timeout', async () => {
    const api = makeWorkbenchFakeApi({
      taskId: 'dd44ee55',
      taskResponses: [
        { task: { id: 'dd44ee55', status: 'running', phase: 'working', error: null }, events: [], permissions: [], version: 1 },
      ],
    })
    let calls = 0
    const deps = baseDeps({ fetch: api.fetchImpl, now: () => { calls++; return calls === 1 ? 0 : 100_000 } })

    const report = await runWorkbenchSelftest(deps, { executor: 'claude', timeoutMs: 1000 })

    const replied = report.checks.find((c) => c.name === 'replied')!
    expect(replied.ok).toBe(false)
    expect(replied.detail).toBe('timeout')
    expect(report.ok).toBe(false)
  })
})

// ── runChatSelftest ──────────────────────────────────────────────────

describe('runChatSelftest', () => {
  it('success: converse body correct, tool_seen via wechat/ping, resume adds resumeSessionId', async () => {
    const calls: RecordedCall[] = []
    let n = 0
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url))
      const body = init?.body ? JSON.parse(init.body as string) : undefined
      calls.push({ method: (init?.method ?? 'GET').toUpperCase(), path: u.pathname, body })
      n++
      if (n === 1) return jsonResponse(200, { ok: true, providerId: 'claude', sessionId: 'sess-1', texts: ['daemon_pid is 4242'], toolCalls: ['wechat/ping'], durationMs: 10 })
      return jsonResponse(200, { ok: true, providerId: 'claude', sessionId: 'sess-1', texts: ['ping'], toolCalls: [], durationMs: 5 })
    }) as unknown as typeof fetch
    const deps = baseDeps({ fetch: fetchImpl })

    const report = await runChatSelftest(deps, { provider: 'claude', resume: true })

    expect(report.kind).toBe('chat')
    expect(report.ok).toBe(true)
    expect(report.sessionId).toBe('sess-1')
    expect(report.checks.find((c) => c.name === 'replied')?.ok).toBe(true)
    expect(report.checks.find((c) => c.name === 'tool_seen')?.ok).toBe(true)
    expect(report.checks.find((c) => c.name === 'resume_replied')?.ok).toBe(true)

    expect(calls[0]!.path).toBe('/v1/selftest/converse')
    expect(calls[0]!.body.providerId).toBe('claude')
    expect(calls[0]!.body.resumeSessionId).toBeUndefined()
    expect(calls[1]!.body.resumeSessionId).toBe('sess-1')
  })

  it('custom --text skips the tool_seen check', async () => {
    const fetchImpl = (async () => jsonResponse(200, { ok: true, providerId: 'claude', sessionId: 's', texts: ['hi'], toolCalls: [], durationMs: 1 })) as unknown as typeof fetch
    const deps = baseDeps({ fetch: fetchImpl })

    const report = await runChatSelftest(deps, { provider: 'claude', text: '你好' })

    expect(report.checks.some((c) => c.name === 'tool_seen')).toBe(false)
    expect(report.ok).toBe(true)
  })

  it('daemon not running (readApiInfo → null) throws daemon_not_running', async () => {
    const deps = baseDeps({ readApiInfo: () => null })
    await expect(runChatSelftest(deps, { provider: 'claude' })).rejects.toThrow('daemon_not_running')
  })
})
