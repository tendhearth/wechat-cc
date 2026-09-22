import { describe, expect, it } from 'vitest'
import { basename, join } from 'node:path'
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
    scratchRoot: '/scratch',
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
function makeWorkbenchFakeApi(opts: { taskId?: string; taskResponses: unknown[]; createStatus?: number; createBody?: unknown; inputStatus?: number }) {
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
      case 'GET /v1/health':
        return jsonResponse(200, { ok: true })
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
      case 'POST /v1/workbench/input':
        return jsonResponse(opts.inputStatus ?? 200, opts.inputStatus && opts.inputStatus >= 300 ? { error: 'input_stale' } : { input: { id: body.requestId, runId: body.runId } })
      case 'POST /v1/workbench/cancel':
        return jsonResponse(202, { task: { id: taskId, status: 'cancelling', phase: 'working', error: null } })
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
        read: (p) => (basename(p) === 'hello.txt' ? 'hello' : null),
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
    expect(createCall.body.path).toBe(join('/scratch', 'wb-5000'))

    const permCall = api.calls.find((c) => c.method === 'POST' && c.path === '/v1/workbench/permission')!
    expect(permCall.body).toEqual({ id: 'ab12cd34', requestId: 'perm-1', decision: 'allow' })

    expect(api.calls.some((c) => c.method === 'POST' && c.path === '/v1/workbench/archive' && c.body.id === 'ab12cd34' && c.body.archived === true)).toBe(true)
    expect(rmCalls).toContain(join('/scratch', 'wb-5000'))
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

  // 2026-09-18 real machine, second finding: with the claude executor the
  // session is RETAINED after it replies (status stays `running`, phase
  // `replied`), and `continueTask()` throws `workbench_busy` for as long as
  // the run is alive — no amount of retrying gets through. The live route
  // is `POST /v1/workbench/input` with the run's `runId`.
  it('--resume on a retained session (status running + runId): goes through /input, not /continue', async () => {
    const api = makeWorkbenchFakeApi({
      taskId: 'aa11bb22',
      taskResponses: [
        {
          task: { id: 'aa11bb22', status: 'running', phase: 'replied', error: null },
          runId: '11111111-2222-4333-8444-555555555555',
          events: [
            { id: 1, kind: 'tool_call', text: 'shell: uname -a', activity: { tool: 'shell' } },
            { id: 2, kind: 'text', text: 'done, wrote hello.txt' },
          ],
          permissions: [{ id: 'perm-1', tool: 'shell', description: 'run uname -a' }],
          version: 5,
        },
        // 交出 input 之后的第一次 poll:phase 仍是 replied(它本来就是),但还没有新事件 ——
        // 续接的等待不能在这里就收工(2026-09-19 真机:8 秒「0 event(s) via input」假红)。
        {
          task: { id: 'aa11bb22', status: 'running', phase: 'replied', error: null },
          runId: '11111111-2222-4333-8444-555555555555',
          events: [],
          permissions: [],
          version: 6,
        },
        {
          task: { id: 'aa11bb22', status: 'running', phase: 'replied', error: null },
          runId: '11111111-2222-4333-8444-555555555555',
          events: [{ id: 3, kind: 'text', text: '第一件事是运行 uname -a' }],
          permissions: [],
          version: 7,
        },
        // finalize: the session is still live, so it gets cancelled — this is
        // the post-cancel wait going terminal.
        { task: { id: 'aa11bb22', status: 'cancelled', phase: 'cancelled', error: null }, events: [], permissions: [], version: 8 },
      ],
    })
    const deps = baseDeps({
      fetch: api.fetchImpl,
      now: () => 7000,
      uuid: () => 'abcdefab-1234-4567-89ab-cdef01234567',
      fs: { mkdir: () => {}, write: () => {}, read: (p) => (basename(p) === 'hello.txt' ? 'hello' : null), rm: () => {} },
    })

    const report = await runWorkbenchSelftest(deps, { executor: 'claude', resume: true })

    expect(api.calls.some((c) => c.path === '/v1/workbench/continue')).toBe(false)
    const input = api.calls.find((c) => c.method === 'POST' && c.path === '/v1/workbench/input')
    expect(input?.body).toEqual({
      id: 'aa11bb22',
      runId: '11111111-2222-4333-8444-555555555555',
      requestId: 'abcdefab-1234-4567-89ab-cdef01234567',
      text: expect.any(String),
    })
    const check = report.checks.find((c) => c.name === 'resume_replied')
    expect(check?.ok).toBe(true)
    expect(check?.detail).toContain('via input')
  })

  it('--resume: /input answers non-2xx ⇒ resume_replied ✗ with the server error', async () => {
    const api = makeWorkbenchFakeApi({
      taskId: 'aa11bb22',
      inputStatus: 409,
      taskResponses: [
        {
          task: { id: 'aa11bb22', status: 'running', phase: 'replied', error: null },
          runId: '11111111-2222-4333-8444-555555555555',
          events: [{ id: 1, kind: 'text', text: 'done, wrote hello.txt' }],
          permissions: [],
          version: 5,
        },
        { task: { id: 'aa11bb22', status: 'cancelled', phase: 'cancelled', error: null }, events: [], permissions: [], version: 6 },
      ],
    })
    const deps = baseDeps({
      fetch: api.fetchImpl,
      now: () => 7000,
      fs: { mkdir: () => {}, write: () => {}, read: (p) => (basename(p) === 'hello.txt' ? 'hello' : null), rm: () => {} },
    })

    const report = await runWorkbenchSelftest(deps, { executor: 'claude', resume: true })

    const check = report.checks.find((c) => c.name === 'resume_replied')
    expect(check?.ok).toBe(false)
    expect(check?.detail).toContain('http_409 input_stale')
    expect(check?.detail).toContain('via input')
    expect(report.ok).toBe(false)
  })

  it('--resume on a settled run (status completed): continue is called and resume_replied passes on new text', async () => {
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
      fs: { mkdir: () => {}, write: () => {}, read: (p) => (basename(p) === 'hello.txt' ? 'hello' : null), rm: () => {} },
    })

    const report = await runWorkbenchSelftest(deps, { executor: 'claude', resume: true })

    expect(api.calls.some((c) => c.method === 'POST' && c.path === '/v1/workbench/continue' && c.body.id === 'cc33dd44')).toBe(true)
    expect(api.calls.some((c) => c.path === '/v1/workbench/input')).toBe(false)
    const check = report.checks.find((c) => c.name === 'resume_replied')
    expect(check?.ok).toBe(true)
    expect(check?.detail).toContain('via continue')
    expect(report.ok).toBe(true)
  })

  // Real machine 2026-09-18 (f65f4c09): `resume_replied` was the ONLY red
  // check of the whole post-deploy selftest — `http_409 workbench_busy`,
  // the transient window where the just-replied run's review snapshot is
  // still being captured. That false negative rolled back a good deploy.
  it('--resume: a transient 409 workbench_busy on continue is retried until it clears', async () => {
    let continueCalls = 0
    const sleeps: number[] = []
    const taskDetail = (id: number, text: string, version: number) => ({
      task: { id: 'ee55ff66', status: 'completed', phase: 'replied', error: null },
      events: [{ id, kind: 'text', text }],
      permissions: [],
      version,
    })
    let taskCalls = 0
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url))
      const method = (init?.method ?? 'GET').toUpperCase()
      const key = `${method} ${u.pathname}`
      switch (key) {
        case 'GET /v1/health': return jsonResponse(200, { ok: true })
        case 'POST /v1/workbench/create':
          return jsonResponse(202, { task: { id: 'ee55ff66', status: 'queued', phase: 'queued', error: null } })
        case 'GET /v1/workbench/task':
          return jsonResponse(200, taskCalls++ === 0 ? taskDetail(1, 'done, wrote hello.txt', 5) : taskDetail(2, '第一件事是运行 uname -a', 7))
        case 'POST /v1/workbench/continue':
          // 409 twice, then it goes through.
          return continueCalls++ < 2
            ? jsonResponse(409, { error: 'workbench_busy' })
            : jsonResponse(202, { task: { id: 'ee55ff66', status: 'running', phase: 'working', error: null } })
        case 'POST /v1/workbench/archive': return jsonResponse(200, { task: { id: 'ee55ff66', archivedAt: 1 } })
        default: throw new Error(`unexpected fetch: ${key}`)
      }
    }) as unknown as typeof fetch
    const deps = baseDeps({
      fetch: fetchImpl,
      now: () => 7000,
      sleep: async (ms) => { sleeps.push(ms) },
      fs: { mkdir: () => {}, write: () => {}, read: (p) => (basename(p) === 'hello.txt' ? 'hello' : null), rm: () => {} },
    })

    const report = await runWorkbenchSelftest(deps, { executor: 'claude', resume: true })

    expect(continueCalls).toBe(3)
    expect(sleeps).toEqual([1_000, 1_000])
    expect(report.checks.find((c) => c.name === 'resume_replied')?.ok).toBe(true)
  })

  it('--resume: a 409 that never clears still fails, bounded by the retry budget', async () => {
    let continueCalls = 0
    const api = makeWorkbenchFakeApi({
      taskId: 'ee55ff66',
      taskResponses: [{
        task: { id: 'ee55ff66', status: 'completed', phase: 'replied', error: null },
        events: [{ id: 1, kind: 'text', text: 'done, wrote hello.txt' }],
        permissions: [],
        version: 5,
      }],
    })
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url))
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method === 'POST' && u.pathname === '/v1/workbench/continue') {
        continueCalls++
        return jsonResponse(409, { error: 'workbench_busy' })
      }
      return api.fetchImpl(url as string, init)
    }) as unknown as typeof fetch
    const deps = baseDeps({
      fetch: fetchImpl,
      now: () => 7000,
      fs: { mkdir: () => {}, write: () => {}, read: (p) => (basename(p) === 'hello.txt' ? 'hello' : null), rm: () => {} },
    })

    const report = await runWorkbenchSelftest(deps, { executor: 'claude', resume: true })

    // 1 first call + 10 retries, then the honest failure.
    expect(continueCalls).toBe(11)
    const check = report.checks.find((c) => c.name === 'resume_replied')
    expect(check?.ok).toBe(false)
    expect(check?.detail).toContain('http_409 workbench_busy')
    expect(report.ok).toBe(false)
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

  it('timeout: no terminal status reached before the deadline ⇒ replied ✗ with detail timeout, and the task is cancelled before archiving (I5)', async () => {
    const api = makeWorkbenchFakeApi({
      taskId: 'dd44ee55',
      taskResponses: [
        { task: { id: 'dd44ee55', status: 'running', phase: 'working', error: null }, events: [], permissions: [], version: 1 },
      ],
    })
    // Clock advances 10s per read: the poll deadline passes, and so does
    // the post-cancel wait — an executor that never goes terminal must not
    // wedge the run.
    let clock = 0
    const deps = baseDeps({ fetch: api.fetchImpl, now: () => { clock += 10_000; return clock } })

    const report = await runWorkbenchSelftest(deps, { executor: 'claude', timeoutMs: 1000 })

    const replied = report.checks.find((c) => c.name === 'replied')!
    expect(replied.ok).toBe(false)
    expect(replied.detail).toBe('timeout')
    expect(report.ok).toBe(false)

    // The timeout path is exactly where the executor is still running, so
    // it's the path that most needs the cancel — it used to archive (and
    // delete the scratch dir) out from under a live subprocess.
    const cancelIdx = api.calls.findIndex((c) => c.method === 'POST' && c.path === '/v1/workbench/cancel')
    const archiveIdx = api.calls.findIndex((c) => c.method === 'POST' && c.path === '/v1/workbench/archive')
    expect(cancelIdx).toBeGreaterThanOrEqual(0)
    expect(api.calls[cancelIdx]!.body).toEqual({ id: 'dd44ee55' })
    expect(archiveIdx).toBeGreaterThan(cancelIdx)
  })

  it('retained-session executor (status stays running while phase is replied): cancel is called before archive, archived check added, scratch deleted after', async () => {
    const api = makeWorkbenchFakeApi({
      taskId: 'ee55ff66',
      taskResponses: [
        // phase1 stops here: phase==='replied' even though status is still 'running' (retained session).
        {
          task: { id: 'ee55ff66', status: 'running', phase: 'replied', error: null },
          events: [
            { id: 1, kind: 'tool_call', text: 'shell: uname -a', activity: { tool: 'shell' } },
            { id: 2, kind: 'text', text: 'done, wrote hello.txt' },
          ],
          permissions: [{ id: 'perm-1', tool: 'shell', description: 'run uname -a' }],
          version: 2,
        },
        // post-cancel wait: status finally goes terminal.
        { task: { id: 'ee55ff66', status: 'cancelled', phase: 'cancelled', error: null }, events: [], permissions: [], version: 3 },
      ],
    })
    const rmCalls: string[] = []
    const deps = baseDeps({
      fetch: api.fetchImpl,
      fs: { mkdir: () => {}, write: () => {}, read: (p) => (basename(p) === 'hello.txt' ? 'hello' : null), rm: (p) => { rmCalls.push(p) } },
    })

    const report = await runWorkbenchSelftest(deps, { executor: 'claude' })

    expect(report.checks.find((c) => c.name === 'replied')?.ok).toBe(true)
    expect(report.checks.find((c) => c.name === 'archived')).toEqual({ name: 'archived', ok: true, detail: undefined })
    expect(report.ok).toBe(true)

    const cancelIdx = api.calls.findIndex((c) => c.method === 'POST' && c.path === '/v1/workbench/cancel')
    const archiveIdx = api.calls.findIndex((c) => c.method === 'POST' && c.path === '/v1/workbench/archive')
    expect(cancelIdx).toBeGreaterThanOrEqual(0)
    expect(archiveIdx).toBeGreaterThan(cancelIdx)
    expect(api.calls[cancelIdx]!.body).toEqual({ id: 'ee55ff66' })

    expect(rmCalls.some((p) => p.startsWith(join('/scratch', 'wb-')))).toBe(true)
  })

  it('create fails (428 unattended_ack_required): created check surfaces the server error, no polling happens', async () => {
    const api = makeWorkbenchFakeApi({
      createStatus: 428,
      createBody: { error: 'unattended_ack_required' },
      taskResponses: [],
    })
    const deps = baseDeps({ fetch: api.fetchImpl })

    const report = await runWorkbenchSelftest(deps, { executor: 'claude' })

    expect(report.checks.find((c) => c.name === 'created')).toEqual({ name: 'created', ok: false, detail: 'http_428 unattended_ack_required' })
    expect(report.ok).toBe(false)
    expect(api.calls.some((c) => c.path === '/v1/workbench/task')).toBe(false)
  })

  it('workbench calls keep the 30s per-call budget (long-poll wait_ms + slack)', async () => {
    const api = makeWorkbenchFakeApi({
      taskId: 'a1b2c3d4',
      taskResponses: [
        { task: { id: 'a1b2c3d4', status: 'completed', phase: 'replied', error: null }, events: [{ id: 1, kind: 'text', text: 'done' }], permissions: [], version: 1 },
      ],
    })
    const budgets: number[] = []
    const deps = baseDeps({
      fetch: api.fetchImpl,
      timeoutSignal: (ms) => { budgets.push(ms); return AbortSignal.timeout(ms) },
      fs: { mkdir: () => {}, write: () => {}, read: () => 'hello', rm: () => {} },
    })

    await runWorkbenchSelftest(deps, { executor: 'claude' })

    expect(budgets.length).toBeGreaterThan(0)
    expect([...new Set(budgets)]).toEqual([30_000])
    const pollCall = api.calls.find((c) => c.path === '/v1/workbench/task')
    expect(pollCall).toBeDefined()
  })

  it('git_init is not in the checks list (logged as a warning instead)', async () => {
    const api = makeWorkbenchFakeApi({
      taskId: 'a1b2c3d4',
      taskResponses: [
        { task: { id: 'a1b2c3d4', status: 'completed', phase: 'replied', error: null }, events: [{ id: 1, kind: 'text', text: 'done' }], permissions: [], version: 1 },
      ],
    })
    const logLines: string[] = []
    const deps = baseDeps({ fetch: api.fetchImpl, git: undefined, log: (line) => logLines.push(line) })

    const report = await runWorkbenchSelftest(deps, { executor: 'claude' })

    expect(report.checks.some((c) => c.name === 'git_init')).toBe(false)
    expect(logLines.some((l) => l.includes('git_init'))).toBe(true)
  })
})

// ── health precheck ──────────────────────────────────────────────────

describe('health precheck', () => {
  it('unreachable daemon (stale internal-api-info.json) ⇒ throws daemon_not_running before touching anything else', async () => {
    const fetchImpl = (async (url: string | URL) => {
      const u = new URL(String(url))
      if (u.pathname === '/v1/health') throw new Error('ECONNREFUSED')
      throw new Error(`unexpected fetch: ${u.pathname}`)
    }) as unknown as typeof fetch
    const deps = baseDeps({ fetch: fetchImpl })

    await expect(runWorkbenchSelftest(deps, { executor: 'claude' })).rejects.toThrow('daemon_not_running')
    await expect(runChatSelftest(deps, { provider: 'claude' })).rejects.toThrow('daemon_not_running')
  })

  it('non-2xx /v1/health ⇒ throws daemon_not_running', async () => {
    const fetchImpl = (async (url: string | URL) => {
      const u = new URL(String(url))
      if (u.pathname === '/v1/health') return jsonResponse(503, { error: 'starting' })
      throw new Error(`unexpected fetch: ${u.pathname}`)
    }) as unknown as typeof fetch
    const deps = baseDeps({ fetch: fetchImpl })

    await expect(runWorkbenchSelftest(deps, { executor: 'claude' })).rejects.toThrow('daemon_not_running')
  })

  it('healthy daemon: precheck uses the FILE token (not the operator token), then the run proceeds', async () => {
    const api = makeWorkbenchFakeApi({
      taskId: 'aa11bb22',
      taskResponses: [{ task: { id: 'aa11bb22', status: 'completed', phase: 'replied', error: null }, events: [{ id: 1, kind: 'text', text: 'ok' }], permissions: [], version: 1 }],
    })
    let healthAuth: string | undefined
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url))
      if (u.pathname === '/v1/health') {
        healthAuth = (init?.headers as Record<string, string> | undefined)?.authorization
        return jsonResponse(200, { ok: true })
      }
      return api.fetchImpl(url as unknown as string, init)
    }) as unknown as typeof fetch
    const deps = baseDeps({ fetch: fetchImpl, fs: { mkdir: () => {}, write: () => {}, read: () => 'hello', rm: () => {} } })

    const report = await runWorkbenchSelftest(deps, { executor: 'claude' })

    expect(healthAuth).toBe('Bearer file-token')
    expect(report.checks.find((c) => c.name === 'created')?.ok).toBe(true)
  })
})

// ── runChatSelftest ──────────────────────────────────────────────────

describe('runChatSelftest', () => {
  it('success: converse body correct, tool_seen via wechat/ping, resume adds resumeSessionId', async () => {
    const calls: RecordedCall[] = []
    let n = 0
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url))
      if (u.pathname === '/v1/health') return jsonResponse(200, { ok: true })
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
    const fetchImpl = (async (url: string | URL) => {
      const u = new URL(String(url))
      if (u.pathname === '/v1/health') return jsonResponse(200, { ok: true })
      return jsonResponse(200, { ok: true, providerId: 'claude', sessionId: 's', texts: ['hi'], toolCalls: [], durationMs: 1 })
    }) as unknown as typeof fetch
    const deps = baseDeps({ fetch: fetchImpl })

    const report = await runChatSelftest(deps, { provider: 'claude', text: '你好' })

    expect(report.checks.some((c) => c.name === 'tool_seen')).toBe(false)
    expect(report.ok).toBe(true)
  })

  it('--resume with no sessionId from the first turn: resume_replied is ✗ and the route is not called a second time', async () => {
    const calls: RecordedCall[] = []
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url))
      if (u.pathname === '/v1/health') return jsonResponse(200, { ok: true })
      calls.push({ method: (init?.method ?? 'GET').toUpperCase(), path: u.pathname, body: init?.body ? JSON.parse(init.body as string) : undefined })
      return jsonResponse(200, { ok: true, providerId: 'claude', sessionId: null, texts: ['hi'], toolCalls: ['wechat/ping'], durationMs: 1 })
    }) as unknown as typeof fetch
    const deps = baseDeps({ fetch: fetchImpl })

    const report = await runChatSelftest(deps, { provider: 'claude', resume: true })

    expect(report.checks.find((c) => c.name === 'resume_replied')).toEqual({ name: 'resume_replied', ok: false, detail: 'no session id from first turn' })
    expect(calls.filter((c) => c.path === '/v1/selftest/converse')).toHaveLength(1)
    expect(report.ok).toBe(false)
  })

  it('HTTP failure on converse (non-503): no_error and replied are both ✗ with the server error in detail', async () => {
    const fetchImpl = (async (url: string | URL) => {
      const u = new URL(String(url))
      if (u.pathname === '/v1/health') return jsonResponse(200, { ok: true })
      return jsonResponse(500, { error: 'boom' })
    }) as unknown as typeof fetch
    const deps = baseDeps({ fetch: fetchImpl })

    const report = await runChatSelftest(deps, { provider: 'claude' })

    expect(report.checks.find((c) => c.name === 'replied')).toEqual({ name: 'replied', ok: false, detail: 'http_500 boom' })
    expect(report.checks.find((c) => c.name === 'no_error')).toEqual({ name: 'no_error', ok: false, detail: 'http_500 boom' })
    expect(report.ok).toBe(false)
  })

  // I3 — right after `self deploy` returns ok, the port + info file are
  // already there but bootstrap may not have wired selftestConverse yet.
  it('503 selftest_not_wired twice, then 200 ⇒ PASS, and the wait shows up in the replied detail', async () => {
    let attempts = 0
    const sleeps: number[] = []
    const fetchImpl = (async (url: string | URL) => {
      const u = new URL(String(url))
      if (u.pathname === '/v1/health') return jsonResponse(200, { ok: true })
      attempts++
      if (attempts <= 2) return jsonResponse(503, { error: 'selftest_not_wired' })
      return jsonResponse(200, { ok: true, providerId: 'claude', sessionId: 's1', texts: ['pong'], toolCalls: ['wechat/ping'], durationMs: 3 })
    }) as unknown as typeof fetch
    let clock = 0
    const deps = baseDeps({ fetch: fetchImpl, now: () => (clock += 2_000), sleep: async (ms) => { sleeps.push(ms) } })

    const report = await runChatSelftest(deps, { provider: 'claude' })

    expect(attempts).toBe(3)
    expect(sleeps).toEqual([2_000, 2_000])
    expect(report.ok).toBe(true)
    expect(report.checks.find((c) => c.name === 'replied')?.detail).toContain('waited')
  })

  it('a 503 that never clears still fails, bounded by the retry budget', async () => {
    let attempts = 0
    const fetchImpl = (async (url: string | URL) => {
      const u = new URL(String(url))
      if (u.pathname === '/v1/health') return jsonResponse(200, { ok: true })
      attempts++
      return jsonResponse(503, { error: 'selftest_not_wired' })
    }) as unknown as typeof fetch
    // 20s per read blows through the 60s budget quickly.
    let clock = 0
    const deps = baseDeps({ fetch: fetchImpl, now: () => (clock += 20_000) })

    const report = await runChatSelftest(deps, { provider: 'claude' })

    expect(report.ok).toBe(false)
    expect(attempts).toBeGreaterThan(1)
    expect(attempts).toBeLessThan(10)
    expect(report.checks.find((c) => c.name === 'replied')?.detail).toContain('http_503 selftest_not_wired')
  })

  // I2 — the converse call runs a whole model turn behind it; the 30s
  // budget that fits every workbench call used to abort it at 30s.
  it('the converse call gets the chat budget (+margin), not the 30s default', async () => {
    const budgets: number[] = []
    const fetchImpl = (async (url: string | URL) => {
      const u = new URL(String(url))
      if (u.pathname === '/v1/health') return jsonResponse(200, { ok: true })
      return jsonResponse(200, { ok: true, providerId: 'claude', sessionId: 's1', texts: ['pong'], toolCalls: ['wechat/ping'], durationMs: 3 })
    }) as unknown as typeof fetch
    const deps = baseDeps({ fetch: fetchImpl, timeoutSignal: (ms) => { budgets.push(ms); return AbortSignal.timeout(ms) } })

    const byDefault = await runChatSelftest(deps, { provider: 'claude' })
    expect(byDefault.ok).toBe(true)
    expect(budgets).toEqual([190_000]) // 180s default + 10s margin

    budgets.length = 0
    await runChatSelftest(deps, { provider: 'claude', timeoutMs: 45_000 })
    expect(budgets).toEqual([55_000])
  })

  it('every call is given an abort signal', async () => {
    let sawSignal = false
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url))
      if (u.pathname === '/v1/health') return jsonResponse(200, { ok: true })
      sawSignal = init?.signal instanceof AbortSignal
      return jsonResponse(200, { ok: true, providerId: 'claude', sessionId: 's1', texts: ['pong'], toolCalls: ['wechat/ping'], durationMs: 3 })
    }) as unknown as typeof fetch

    const report = await runChatSelftest(baseDeps({ fetch: fetchImpl }), { provider: 'claude' })

    expect(sawSignal).toBe(true)
    // …and the report's own duration is not capped by any per-call budget.
    expect(report.durationMs).toBe(0)
  })

  it('daemon not running (readApiInfo → null) throws daemon_not_running', async () => {
    const deps = baseDeps({ readApiInfo: () => null })
    await expect(runChatSelftest(deps, { provider: 'claude' })).rejects.toThrow('daemon_not_running')
  })
})


it('preserves the scratch project when archive fails, even after a terminal reply',async()=>{
  const api=makeWorkbenchFakeApi({taskResponses:[{task:{status:'completed'},events:[{id:1,kind:'text',text:'done'}],version:1}]})
  const removed:string[]=[]
  const deps=baseDeps({fetch:(async(url,init)=>new URL(String(url)).pathname==='/v1/workbench/archive'
    ? jsonResponse(409,{error:'workbench_busy'}):api.fetchImpl(url,init)) as typeof fetch})
  deps.fs.rm=p=>removed.push(p)
  const report=await runWorkbenchSelftest(deps,{executor:'claude'})
  expect(report.checks.find(c=>c.name==='archived')?.ok).toBe(false)
  expect(removed).toEqual([])
})

it('requests an explicit root file and a controlled permission probe, rather than assuming uname asks',async()=>{
  const api=makeWorkbenchFakeApi({taskResponses:[{task:{status:'completed'},events:[],version:1}]})
  const files=new Map<string,string>()
  const deps=baseDeps({fetch:api.fetchImpl})
  deps.fs.write=(p,v)=>files.set(p,String(v))
  await runWorkbenchSelftest(deps,{executor:'claude'})
  const prompt=api.calls.find(c=>c.path==='/v1/workbench/create')!.body.text
  expect(prompt).toContain('项目根目录')
  expect(prompt).toContain('rm -- cc-selftest-permission-probe.txt')
  // 期望值用 join 拼:deps.fs.write 记的是产品用 join(scratchPath, …) 拼出来的
  // 真实路径,Windows 上是反斜杠,POSIX 字面量在那边永远取不到。
  expect(files.get(join('/scratch', 'wb-1000', 'cc-selftest-permission-probe.txt'))).toBeDefined()
})


it('fails permission execution when approval returns OK but the disposable file remains',async()=>{
  const api=makeWorkbenchFakeApi({taskResponses:[{task:{status:'completed'},events:[{id:1,kind:'text',text:'done'}],permissions:[{id:'p',tool:'Bash',description:'rm -- cc-selftest-permission-probe.txt'}],version:1}]})
  const deps=baseDeps({fetch:api.fetchImpl})
  deps.fs.read=p=>p.endsWith('cc-selftest-permission-probe.txt')?'not removed':null
  const report=await runWorkbenchSelftest(deps,{executor:'claude'})
  expect(report.checks.find(c=>c.name==='permission_roundtrip')?.ok).toBe(true)
  expect(report.checks.find(c=>c.name==='permission_executed')?.ok).toBe(false)
})


it('requests Codex native escalation explicitly for the disposable probe',async()=>{
  const api=makeWorkbenchFakeApi({taskResponses:[{task:{status:'completed'},events:[],version:1}]})
  await runWorkbenchSelftest(baseDeps({fetch:api.fetchImpl}),{executor:'codex'})
  expect(api.calls.find(c=>c.path==='/v1/workbench/create')!.body.text).toContain('require_escalated')
})
