import { describe, expect, it } from 'vitest'
import type { ProtocolClient, ProtocolResponse } from '@wechat-cc/protocol'
import {
  formatPhoneSelftestReport,
  PHONE_SELFTEST_EXIT,
  runPhoneSelftest,
  type PhoneSelftestDeps,
  type PhoneSelftestReport,
} from './selftest-phone'

// ── test scaffolding ───────────────────────────────────────────────

interface RecordedCall { method: string; path: string; body: any }

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response
}

const REMOTE_LINK_URL = 'https://relay.example.com/pset/#id=daemon-1&t=link-tok&p=%2Fset&lan=192.168.1.5:51234'
const LAN_ONLY_URL = 'http://192.168.1.5:51234/set?t=link-tok'

function makeResponse(status: number, body: unknown): ProtocolResponse {
  const text = JSON.stringify(body)
  return {
    status,
    headers: {},
    body: new TextEncoder().encode(text),
    text: () => text,
    json: <T>() => body as T,
  }
}

/** A fully scripted fake `ProtocolClient` — tests control `request`/`subscribe`
 *  directly instead of re-simulating the wire protocol (that's covered by
 *  `packages/protocol`'s own suite). `emit(topic, data, meta)` pushes to every
 *  live subscriber of that topic. */
function fakeClient(opts: {
  version?: 1 | 2 | null
  onRequest?: (req: { method: string; path: string; body?: unknown }) => ProtocolResponse | Promise<ProtocolResponse>
} = {}): { client: ProtocolClient; requests: RecordedCall[]; emit: (topic: string, data: unknown, meta?: { epoch: string; seq: number }) => void; closed: boolean } {
  const requests: RecordedCall[] = []
  const subs = new Map<string, { topic: string; cb: (data: unknown, meta: { epoch: string; seq: number }) => void }>()
  let sidSeq = 0
  const state = { closed: false, version: opts.version ?? 2 }
  const client: ProtocolClient = {
    version: () => state.version,
    async request(req) {
      requests.push({ method: req.method, path: req.path, body: req.body })
      if (opts.onRequest) return await opts.onRequest({ method: req.method, path: req.path, body: req.body })
      return makeResponse(200, {})
    },
    subscribe(topic, cb) {
      const sid = `s${++sidSeq}`
      subs.set(sid, { topic, cb })
      return () => { subs.delete(sid) }
    },
    close() { state.closed = true },
  }
  return {
    client,
    requests,
    emit: (topic, data, meta = { epoch: 'e1', seq: subs.size ? 1 : 1 }) => {
      for (const s of subs.values()) if (s.topic === topic) s.cb(data, meta)
    },
    get closed() { return state.closed },
  }
}

/** Every secret credential used across these tests. No check/report may
 *  ever contain any of these substrings — see the "no token in output"
 *  suite below, and every scenario test's trailing `assertNoTokenLeak`
 *  call. */
const SECRET_TOKENS = ['link-tok', 'device-tok', 'file-token', 'op-token']

function assertNoTokenLeak(report: PhoneSelftestReport): void {
  const text = JSON.stringify(report)
  for (const token of SECRET_TOKENS) expect(text, `report leaked a credential: ${token}`).not.toContain(token)
}

/** Simulates a bubbled fetch/relay/WebSocket error whose message embeds a
 *  raw token — the shape Bun/undici errors commonly take for a failed
 *  request ("Failed to parse URL from <url>", connection-refused messages
 *  that echo the URL, and so on). Fix round 2: these must come out
 *  redacted no matter which call site they bubble up from. */
function tokenLeakingError(token: string): Error {
  return new Error(`Failed to parse URL from http://192.168.1.5:51234/set/api/apply?t=${token}`)
}

/** A device client whose `/set/api/state` request over the relay always
 *  rejects — e.g. a flaky tunnel right after pairing. `deviceId` never gets
 *  established this way, so cleanup has to fall back to a LAN lookup. */
function connectWithFailingRelayState(opts: { error?: () => Error } = {}): PhoneSelftestDeps['connect'] {
  return (_url, token) => {
    if (token === 'link-tok') {
      const { client } = fakeClient({ onRequest: (req) => {
        if (req.path === '/set/api/pair') return makeResponse(200, { ok: true, device_token: 'device-tok' })
        throw new Error(`unexpected: ${req.path}`)
      } })
      return client
    }
    const { client } = fakeClient({ onRequest: () => { throw opts.error ? opts.error() : new Error('relay_timeout') } })
    return client
  }
}

function baseDeps(overrides: Partial<PhoneSelftestDeps> = {}): PhoneSelftestDeps {
  const dirs = new Set<string>()
  return {
    fetch: (async () => { throw new Error('fetch not stubbed for this test') }) as unknown as typeof fetch,
    readApiInfo: () => ({ baseUrl: 'http://127.0.0.1:9', token: 'file-token', operatorToken: 'op-token' }),
    scratchRoot: '/scratch',
    fs: {
      mkdir: (p) => { dirs.add(p) },
      rm: (p) => { dirs.delete(p) },
    },
    now: () => 1000,
    sleep: async () => {},
    connect: () => { throw new Error('connect not stubbed for this test') },
    log: () => {},
    ...overrides,
  }
}

// ── formatPhoneSelftestReport ────────────────────────────────────────

describe('formatPhoneSelftestReport', () => {
  it('renders ✓/✗ lines with details, and PASS on an ok report', () => {
    const r: PhoneSelftestReport = {
      ok: true, kind: 'phone', target: 'claude', durationMs: 10,
      checks: [{ name: 'paired', ok: true }, { name: 'device_v2', ok: true }],
    }
    const out = formatPhoneSelftestReport(r)
    expect(out).toContain('✓ paired')
    expect(out).toContain('✓ device_v2')
    expect(out.trim().endsWith('PASS')).toBe(true)
  })
  it('renders FAIL and ✗ lines with detail on a failing report', () => {
    const r: PhoneSelftestReport = { ok: false, kind: 'phone', target: 'claude', durationMs: 1, checks: [{ name: 'paired', ok: false, detail: 'device_limit' }] }
    const out = formatPhoneSelftestReport(r)
    expect(out).toContain('✗ paired — device_limit')
    expect(out.trim().endsWith('FAIL')).toBe(true)
  })
})

it('PHONE_SELFTEST_EXIT codes match the rest of the selftest family: ok=0, failed=1, noDaemon=2', () => {
  expect(PHONE_SELFTEST_EXIT).toEqual({ ok: 0, failed: 1, noDaemon: 2 })
})

// ── daemon not running ──────────────────────────────────────────────

it('daemon not running: readApiInfo() null ⇒ throws daemon_not_running before touching the network', async () => {
  const deps = baseDeps({ readApiInfo: () => null })
  await expect(runPhoneSelftest(deps, { executor: 'claude' })).rejects.toThrow('daemon_not_running')
})

// ── remote disabled ─────────────────────────────────────────────────

describe('remote access off', () => {
  it('LAN-only link shape ⇒ FAIL immediately with the exact guidance, no relay/pairing attempted', async () => {
    const fetchImpl = (async (url: string | URL) => {
      const u = new URL(String(url))
      if (u.pathname === '/v1/settings/link') return jsonResponse(200, { url: LAN_ONLY_URL })
      throw new Error(`unexpected fetch: ${u.pathname}`)
    }) as unknown as typeof fetch
    const deps = baseDeps({ fetch: fetchImpl, connect: () => { throw new Error('must not connect when remote is off') } })
    const report = await runPhoneSelftest(deps, { executor: 'claude' })
    expect(report.ok).toBe(false)
    const remote = report.checks.find((c) => c.name === 'remote_enabled')
    expect(remote).toEqual({ name: 'remote_enabled', ok: false, detail: 'remote access is off — enable 出门也能用 in settings' })
    assertNoTokenLeak(report)
  })
})

// ── GET /v1/settings/link failure ───────────────────────────────────

it('settings/link route errors ⇒ FAIL with the http error, no relay attempted', async () => {
  const fetchImpl = (async () => jsonResponse(403, { error: 'route_not_allowed' })) as unknown as typeof fetch
  const deps = baseDeps({ fetch: fetchImpl, connect: () => { throw new Error('must not connect') } })
  const report = await runPhoneSelftest(deps, { executor: 'claude' })
  expect(report.ok).toBe(false)
  expect(report.checks[0]).toEqual({ name: 'link_url', ok: false, detail: 'http_403 route_not_allowed' })
  assertNoTokenLeak(report)
})

// ── relay unreachable ────────────────────────────────────────────────

describe('relay unreachable', () => {
  it('link client request rejects ⇒ paired ✗ with a relay_unreachable detail, no device client created', async () => {
    const fetchImpl = (async (url: string | URL) => {
      const u = new URL(String(url))
      if (u.pathname === '/v1/settings/link') return jsonResponse(200, { url: REMOTE_LINK_URL })
      throw new Error(`unexpected fetch: ${u.pathname}`)
    }) as unknown as typeof fetch
    let connectCalls = 0
    const deps = baseDeps({
      fetch: fetchImpl,
      connect: (url, token) => {
        connectCalls++
        expect(url).toBe('wss://relay.example.com/tunnel/phone?id=daemon-1')
        expect(token).toBe('link-tok')
        return {
          version: () => null,
          request: async () => { throw new Error('unreachable') },
          subscribe: () => () => {},
          close: () => {},
        }
      },
    })
    const report = await runPhoneSelftest(deps, { executor: 'claude' })
    expect(report.ok).toBe(false)
    const paired = report.checks.find((c) => c.name === 'paired')
    expect(paired?.ok).toBe(false)
    expect(paired?.detail).toContain('relay unreachable')
    expect(paired?.detail).toContain('unreachable')
    expect(connectCalls).toBe(1)
    assertNoTokenLeak(report)
  })
})

// ── pairing limit (device_limit) ─────────────────────────────────────

describe('pairing limit', () => {
  it('device_limit response ⇒ paired ✗, no device client, no revoke attempted', async () => {
    const fetchImpl = (async (url: string | URL) => {
      const u = new URL(String(url))
      if (u.pathname === '/v1/settings/link') return jsonResponse(200, { url: REMOTE_LINK_URL })
      throw new Error(`unexpected fetch: ${u.pathname}`)
    }) as unknown as typeof fetch
    let deviceConnectAttempted = false
    const deps = baseDeps({
      fetch: fetchImpl,
      connect: (url, token) => {
        if (token !== 'link-tok') deviceConnectAttempted = true
        const { client, requests } = fakeClient({
          onRequest: (req) => {
            if (req.path === '/set/api/pair') return makeResponse(200, { ok: false, error: 'device_limit' })
            throw new Error(`unexpected request: ${req.path}`)
          },
        })
        void requests
        return client
      },
    })
    const report = await runPhoneSelftest(deps, { executor: 'claude' })
    expect(report.ok).toBe(false)
    expect(report.checks.find((c) => c.name === 'paired')).toEqual({ name: 'paired', ok: false, detail: 'device_limit' })
    expect(deviceConnectAttempted).toBe(false)
    expect(report.checks.find((c) => c.name === 'revoked')).toBeUndefined()
    assertNoTokenLeak(report)
  })
})

// ── device is not v2 ──────────────────────────────────────────────────

describe('device negotiates v1 (not v2)', () => {
  it('device_v2 ✗ "daemon is not v2", still tries to revoke the paired device using the id from /set/api/state', async () => {
    const fetchCalls: RecordedCall[] = []
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url))
      fetchCalls.push({ method: init?.method ?? 'GET', path: u.pathname, body: init?.body ? JSON.parse(init.body as string) : undefined })
      if (u.pathname === '/v1/settings/link') return jsonResponse(200, { url: REMOTE_LINK_URL })
      if (u.pathname === '/set/api/apply') return jsonResponse(200, { ok: true })
      throw new Error(`unexpected fetch: ${u.pathname}`)
    }) as unknown as typeof fetch
    let deviceClientConnectCount = 0
    const deps = baseDeps({
      fetch: fetchImpl,
      connect: (_url, token) => {
        if (token === 'link-tok') {
          const { client } = fakeClient({ onRequest: (req) => {
            if (req.path === '/set/api/pair') return makeResponse(200, { ok: true, device_token: 'device-tok' })
            throw new Error(`unexpected: ${req.path}`)
          } })
          return client
        }
        deviceClientConnectCount++
        // A fresh v1-negotiated client (used for both the initial device
        // connection and the post-revoke auth_failed probe).
        const { client } = fakeClient({
          version: 1,
          onRequest: (req) => {
            if (req.path === '/set/api/state') return makeResponse(200, { remote: { devices: [{ id: 'dev-42', current: true }] } })
            throw new Error(`unexpected: ${req.path}`)
          },
        })
        return client
      },
    })
    const report = await runPhoneSelftest(deps, { executor: 'claude' })
    expect(report.ok).toBe(false)
    expect(report.checks.find((c) => c.name === 'device_v2')).toEqual({ name: 'device_v2', ok: false, detail: 'daemon is not v2' })
    expect(report.checks.find((c) => c.name === 'device_id')).toEqual({ name: 'device_id', ok: true, detail: 'dev-42' })
    // Cleanup still tried to revoke the throwaway device.
    const apply = fetchCalls.find((c) => c.path === '/set/api/apply')
    expect(apply?.body).toEqual({ op: 'revoke_device', id: 'dev-42' })
    expect(report.checks.find((c) => c.name === 'revoked')?.ok).toBe(true)
    expect(deviceClientConnectCount).toBeGreaterThanOrEqual(1)
    assertNoTokenLeak(report)
  })
})

// ── event timeout ─────────────────────────────────────────────────────

describe('agents event timeout', () => {
  it('subscribe never delivers a snapshot ⇒ agents_subscribed ✗ timeout, task never created, device still revoked in cleanup', async () => {
    const fetchCalls: RecordedCall[] = []
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url))
      fetchCalls.push({ method: init?.method ?? 'GET', path: u.pathname, body: init?.body ? JSON.parse(init.body as string) : undefined })
      if (u.pathname === '/v1/settings/link') return jsonResponse(200, { url: REMOTE_LINK_URL })
      if (u.pathname === '/set/api/apply') return jsonResponse(200, { ok: true })
      if (u.pathname === '/v1/workbench/create') throw new Error('must not create a task if agents never subscribed')
      throw new Error(`unexpected fetch: ${u.pathname}`)
    }) as unknown as typeof fetch
    let clock = 0
    const deps = baseDeps({
      fetch: fetchImpl,
      now: () => (clock += 10_000),
      connect: (_url, token) => {
        if (token === 'link-tok') {
          const { client } = fakeClient({ onRequest: (req) => {
            if (req.path === '/set/api/pair') return makeResponse(200, { ok: true, device_token: 'device-tok' })
            throw new Error(`unexpected: ${req.path}`)
          } })
          return client
        }
        const { client } = fakeClient({
          onRequest: (req) => {
            if (req.path === '/set/api/state') return makeResponse(200, { remote: { devices: [{ id: 'dev-9', current: true }] } })
            throw new Error(`unexpected: ${req.path}`)
          },
          // subscribe() never emits anything — simulates a relay that
          // never delivers the initial 'agents' snapshot.
        })
        return client
      },
    })
    const report = await runPhoneSelftest(deps, { executor: 'claude', timeoutMs: 1000 })
    expect(report.ok).toBe(false)
    expect(report.checks.find((c) => c.name === 'agents_subscribed')).toEqual({ name: 'agents_subscribed', ok: false, detail: 'timeout waiting for initial agents snapshot' })
    expect(report.checks.some((c) => c.name === 'task_created')).toBe(false)
    expect(fetchCalls.some((c) => c.path === '/v1/workbench/create')).toBe(false)
    // Cleanup still revoked the paired throwaway device.
    expect(report.checks.find((c) => c.name === 'revoked')?.ok).toBe(true)
    assertNoTokenLeak(report)
  })
})

// ── revoke failure ─────────────────────────────────────────────────────

describe('revoke failure', () => {
  it('LAN /set/api/apply revoke_device fails ⇒ revoked ✗ with a settings-page instruction (no token), overall FAIL', async () => {
    const fetchCalls: RecordedCall[] = []
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url))
      fetchCalls.push({ method: init?.method ?? 'GET', path: u.pathname, body: init?.body ? JSON.parse(init.body as string) : undefined })
      if (u.pathname === '/v1/settings/link') return jsonResponse(200, { url: REMOTE_LINK_URL })
      if (u.pathname === '/set/api/apply') return jsonResponse(200, { ok: false, error: 'unknown_device' })
      throw new Error(`unexpected fetch: ${u.pathname}`)
    }) as unknown as typeof fetch
    const deps = baseDeps({
      fetch: fetchImpl,
      connect: (_url, token) => {
        if (token === 'link-tok') {
          const { client } = fakeClient({ onRequest: (req) => {
            if (req.path === '/set/api/pair') return makeResponse(200, { ok: true, device_token: 'device-tok' })
            throw new Error(`unexpected: ${req.path}`)
          } })
          return client
        }
        const { client } = fakeClient({
          onRequest: (req) => {
            if (req.path === '/set/api/state') return makeResponse(200, { remote: { devices: [{ id: 'dev-7', current: true }] } })
            throw new Error(`unexpected: ${req.path}`)
          },
        })
        return client
      },
    })
    let clock = 0
    const report = await runPhoneSelftest({ ...deps, now: () => (clock += 10_000) }, { executor: 'claude', timeoutMs: 1000 })
    expect(report.ok).toBe(false)
    const revoked = report.checks.find((c) => c.name === 'revoked')
    expect(revoked?.ok).toBe(false)
    expect(revoked?.detail).toContain('unknown_device')
    // Ruling: never print a token. The manual fallback must point at the
    // settings page and identify the device by id (never by a curl command
    // embedding the live device token).
    expect(revoked?.detail).toContain('/set')
    expect(revoked?.detail).toContain('已配对设备')
    expect(revoked?.detail).toContain('忘掉')
    expect(revoked?.detail).toContain('dev-7')
    expect(revoked?.detail).not.toContain('curl')
    // A failed revoke must not claim the follow-up auth_failed check passed.
    expect(report.checks.find((c) => c.name === 'revoked_auth_failed')).toBeUndefined()
    assertNoTokenLeak(report)
  })
})

// ── success path ──────────────────────────────────────────────────────

describe('success path', () => {
  it('all checks pass: paired, v2, agents subscription sees the task arrive and leave in order, revoked + auth_failed after', async () => {
    const fetchCalls: RecordedCall[] = []

    // The device client's 'agents' subscription, wired by hand (not the
    // generic `fakeClient` helper) so the test can drive it in lockstep
    // with fetch calls and with `sleep()` — deterministically, no reliance
    // on a real clock or extra polling iterations.
    let agentsCb: ((data: unknown, meta: { epoch: string; seq: number }) => void) | undefined
    let seq = 0
    const emitAgents = (tasks: Array<{ id: string; title: string; phase: string }>) => {
      seq += 1
      agentsCb?.({ running: tasks.length, waiting: 0, tasks }, { epoch: 'e1', seq })
    }

    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url))
      fetchCalls.push({ method: init?.method ?? 'GET', path: u.pathname, body: init?.body ? JSON.parse(init.body as string) : undefined })
      if (u.pathname === '/v1/settings/link') return jsonResponse(200, { url: REMOTE_LINK_URL })
      if (u.pathname === '/v1/workbench/create') {
        // The real daemon would only start reflecting the task in `agents`
        // asynchronously; emitting it here (before this call resolves) is
        // the fake-fetch equivalent — by the time `runPhoneSelftest` moves
        // on to wait for it, the snapshot is already in `agentEvents`.
        emitAgents([{ id: 'task-1', title: 'selftest-phone', phase: 'working' }])
        return jsonResponse(202, { task: { id: 'task-1', status: 'queued', phase: 'queued' } })
      }
      if (u.pathname === '/v1/workbench/archive') return jsonResponse(200, { task: { id: 'task-1', archivedAt: 1 } })
      if (u.pathname === '/set/api/apply') return jsonResponse(200, { ok: true })
      throw new Error(`unexpected fetch: ${u.pathname}`)
    }) as unknown as typeof fetch

    let postRevokeClientCount = 0
    const deps = baseDeps({
      fetch: fetchImpl,
      // The task's terminal ('leaves agents') snapshot arrives during the
      // wait for it — deliver it on the very first `sleep()` call, which is
      // exactly the point `waitUntil`'s poll loop is blocked at, waiting
      // for the task to disappear.
      sleep: async () => { emitAgents([]) },
      connect: (url, token) => {
        expect(url).toBe('wss://relay.example.com/tunnel/phone?id=daemon-1')
        if (token === 'link-tok') {
          const { client } = fakeClient({ onRequest: (req) => {
            if (req.path === '/set/api/pair') return makeResponse(200, { ok: true, device_token: 'device-tok' })
            throw new Error(`unexpected: ${req.path}`)
          } })
          return client
        }
        expect(token).toBe('device-tok')
        postRevokeClientCount++
        if (postRevokeClientCount > 1) {
          // The fresh post-revoke client must see auth_failed.
          return {
            version: () => null,
            request: async () => { throw new Error('auth_failed') },
            subscribe: () => () => {},
            close: () => {},
          }
        }
        const client: ProtocolClient = {
          version: () => 2,
          async request(req) {
            if (req.path === '/set/api/state') return makeResponse(200, { remote: { devices: [{ id: 'dev-1', current: true }] } })
            throw new Error(`unexpected: ${req.path}`)
          },
          subscribe(topic, cb) {
            if (topic === 'agents') {
              agentsCb = cb
              emitAgents([]) // initial snapshot, delivered synchronously on subscribe
            }
            return () => { agentsCb = undefined }
          },
          close() {},
        }
        return client
      },
    })

    const report = await runPhoneSelftest(deps, { executor: 'claude', timeoutMs: 5000 })
    expect(report.ok).toBe(true)
    expect(report.taskId).toBe('task-1')
    for (const name of ['link_url', 'remote_enabled', 'paired', 'device_v2', 'device_id', 'agents_subscribed', 'task_created', 'agents_task_seen', 'agents_task_terminal', 'agents_event_order', 'archived', 'revoked', 'revoked_auth_failed']) {
      const c = report.checks.find((x) => x.name === name)
      expect(c, `missing/failing check ${name}: ${JSON.stringify(c)}`).toBeTruthy()
      expect(c!.ok, `check ${name} failed: ${c!.detail}`).toBe(true)
    }
    const revokeCall = fetchCalls.find((c) => c.path === '/set/api/apply')
    expect(revokeCall?.body).toEqual({ op: 'revoke_device', id: 'dev-1' })
    expect(report.durationMs).toBeGreaterThanOrEqual(0)
    assertNoTokenLeak(report)
  })
})

// ── device id unknown at cleanup time (relay /set/api/state failed) ────
//
// Ruling (fix round 1, item 2): if `/set/api/state` over the relay fails
// after pairing, cleanup must not just print vague prose — it must first
// try to recover the device id over the LAN (`GET .../set/api/state?t=`)
// and revoke it there. Only if THAT also fails does it fall back to the
// settings-page instruction, identifying the device by its pairing time
// (never by id, since the id was never found — and never by token).

describe('device id unknown at cleanup (relay state call failed)', () => {
  function baseFetchImpl(opts: { lanState?: 'ok' | 'fail'; lanRevoke?: 'ok' | 'fail' }, fetchCalls: RecordedCall[]) {
    return (async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url))
      const method = init?.method ?? 'GET'
      fetchCalls.push({ method, path: u.pathname, body: init?.body ? JSON.parse(init.body as string) : undefined })
      if (u.pathname === '/v1/settings/link') return jsonResponse(200, { url: REMOTE_LINK_URL })
      if (u.pathname === '/set/api/state' && method === 'GET') {
        if (opts.lanState === 'fail') return jsonResponse(500, { error: 'lan_unreachable' })
        return jsonResponse(200, { remote: { devices: [{ id: 'dev-55', current: true }] } })
      }
      if (u.pathname === '/set/api/apply') {
        if (opts.lanRevoke === 'fail') return jsonResponse(200, { ok: false, error: 'unknown_device' })
        return jsonResponse(200, { ok: true })
      }
      throw new Error(`unexpected fetch: ${u.pathname}`)
    }) as unknown as typeof fetch
  }

  it('LAN /set/api/state recovers the id ⇒ LAN revoke attempted and reported ✓', async () => {
    const fetchCalls: RecordedCall[] = []
    const deps = baseDeps({
      fetch: baseFetchImpl({ lanState: 'ok', lanRevoke: 'ok' }, fetchCalls),
      connect: connectWithFailingRelayState(),
    })
    const report = await runPhoneSelftest(deps, { executor: 'claude' })
    expect(report.checks.find((c) => c.name === 'device_connected')).toMatchObject({ ok: false })
    expect(report.checks.find((c) => c.name === 'revoked')).toEqual({ name: 'revoked', ok: true })
    const lanState = fetchCalls.find((c) => c.path === '/set/api/state')
    expect(lanState?.method).toBe('GET')
    const revokeCall = fetchCalls.find((c) => c.path === '/set/api/apply')
    expect(revokeCall?.body).toEqual({ op: 'revoke_device', id: 'dev-55' })
    assertNoTokenLeak(report)
  })

  it('LAN /set/api/state also fails ⇒ revoked ✗ with the settings-page instruction identified by pairing time, no token', async () => {
    const fetchCalls: RecordedCall[] = []
    const deps = baseDeps({
      fetch: baseFetchImpl({ lanState: 'fail' }, fetchCalls),
      connect: connectWithFailingRelayState(),
      now: () => 1_000,
    })
    const report = await runPhoneSelftest(deps, { executor: 'claude' })
    expect(report.ok).toBe(false)
    const revoked = report.checks.find((c) => c.name === 'revoked')
    expect(revoked?.ok).toBe(false)
    expect(revoked?.detail).toContain('/set')
    expect(revoked?.detail).toContain('已配对设备')
    expect(revoked?.detail).toContain('忘掉')
    // No device id was ever found — identify by pairing time instead.
    expect(revoked?.detail).toContain(new Date(1000).toISOString())
    expect(fetchCalls.some((c) => c.path === '/set/api/apply')).toBe(false)
    assertNoTokenLeak(report)
  })
})

// ── fix round 2: a token reachable only via a bubbled fetch/relay error ──
//
// Ruling: `jsonCall`'s catch sets `json.error = err.message`, and runtime
// fetch errors (Bun/undici) commonly embed the full request URL — which,
// for every LAN call in this module, carries the device token as `t=`.
// The earlier fix (round 1) redacted the specific strings we constructed
// ourselves (the curl command, the raw link URL) but missed that an
// *error message* can carry the same token through the exact same
// checks-detail plumbing. The fix is one central sanitizer applied at the
// single point every check is recorded (`makeCheckRecorder`/`rec.push`),
// not per call site — these tests exercise every fetch/relay call that can
// throw with a URL/token-embedding message and confirm nothing leaks.

describe('token reachable via a bubbled fetch/relay error (fix round 2)', () => {
  it('LAN /set/api/apply revoke fetch rejects with a URL-embedding error ⇒ redacted in the revoked check', async () => {
    const fetchImpl = (async (url: string | URL) => {
      const u = new URL(String(url))
      if (u.pathname === '/v1/settings/link') return jsonResponse(200, { url: REMOTE_LINK_URL })
      if (u.pathname === '/set/api/apply') throw tokenLeakingError('device-tok')
      throw new Error(`unexpected fetch: ${u.pathname}`)
    }) as unknown as typeof fetch
    const deps = baseDeps({
      fetch: fetchImpl,
      connect: (_url, token) => {
        if (token === 'link-tok') {
          const { client } = fakeClient({ onRequest: (req) => {
            if (req.path === '/set/api/pair') return makeResponse(200, { ok: true, device_token: 'device-tok' })
            throw new Error(`unexpected: ${req.path}`)
          } })
          return client
        }
        // device_v2 fails ⇒ cleanup revokes using the id it already has
        // (from this same relay call), reaching the vulnerable /set/api/apply
        // fetch directly, no LAN id-recovery detour needed.
        const { client } = fakeClient({
          version: 1,
          onRequest: (req) => {
            if (req.path === '/set/api/state') return makeResponse(200, { remote: { devices: [{ id: 'dev-42', current: true }] } })
            throw new Error(`unexpected: ${req.path}`)
          },
        })
        return client
      },
    })
    const report = await runPhoneSelftest(deps, { executor: 'claude' })
    const revoked = report.checks.find((c) => c.name === 'revoked')
    expect(revoked?.ok).toBe(false)
    expect(revoked?.detail).not.toContain('device-tok')
    expect(revoked?.detail).toContain('<redacted>')
    assertNoTokenLeak(report)
  })

  it('LAN /set/api/state (id-recovery fallback) fetch rejects with a URL-embedding error ⇒ no leak', async () => {
    const fetchImpl = (async (url: string | URL) => {
      const u = new URL(String(url))
      if (u.pathname === '/v1/settings/link') return jsonResponse(200, { url: REMOTE_LINK_URL })
      if (u.pathname === '/set/api/state') throw tokenLeakingError('device-tok')
      throw new Error(`unexpected fetch: ${u.pathname}`)
    }) as unknown as typeof fetch
    const deps = baseDeps({
      fetch: fetchImpl,
      connect: connectWithFailingRelayState(),
    })
    const report = await runPhoneSelftest(deps, { executor: 'claude' })
    const revoked = report.checks.find((c) => c.name === 'revoked')
    expect(revoked?.ok).toBe(false)
    assertNoTokenLeak(report)
  })

  it('relay pairing request rejects with a token-embedding error message ⇒ redacted in the paired check', async () => {
    const fetchImpl = (async (url: string | URL) => {
      const u = new URL(String(url))
      if (u.pathname === '/v1/settings/link') return jsonResponse(200, { url: REMOTE_LINK_URL })
      throw new Error(`unexpected fetch: ${u.pathname}`)
    }) as unknown as typeof fetch
    const deps = baseDeps({
      fetch: fetchImpl,
      connect: () => ({
        version: () => null,
        request: async () => { throw new Error('connect ECONNRESET, retried with token=link-tok') },
        subscribe: () => () => {},
        close: () => {},
      }),
    })
    const report = await runPhoneSelftest(deps, { executor: 'claude' })
    const paired = report.checks.find((c) => c.name === 'paired')
    expect(paired?.ok).toBe(false)
    expect(paired?.detail).not.toContain('link-tok')
    expect(paired?.detail).toContain('<redacted>')
    assertNoTokenLeak(report)
  })

  it('relay device-state request rejects with a token-embedding error message ⇒ redacted, LAN fallback still runs and revokes', async () => {
    const fetchCalls: RecordedCall[] = []
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url))
      fetchCalls.push({ method: init?.method ?? 'GET', path: u.pathname, body: init?.body ? JSON.parse(init.body as string) : undefined })
      if (u.pathname === '/v1/settings/link') return jsonResponse(200, { url: REMOTE_LINK_URL })
      if (u.pathname === '/set/api/state') return jsonResponse(200, { remote: { devices: [{ id: 'dev-77', current: true }] } })
      if (u.pathname === '/set/api/apply') return jsonResponse(200, { ok: true })
      throw new Error(`unexpected fetch: ${u.pathname}`)
    }) as unknown as typeof fetch
    const deps = baseDeps({
      fetch: fetchImpl,
      connect: connectWithFailingRelayState({ error: () => new Error('read ECONNRESET (token device-tok)') }),
    })
    const report = await runPhoneSelftest(deps, { executor: 'claude' })
    const deviceConnected = report.checks.find((c) => c.name === 'device_connected')
    expect(deviceConnected?.ok).toBe(false)
    expect(deviceConnected?.detail).not.toContain('device-tok')
    expect(report.checks.find((c) => c.name === 'revoked')).toEqual({ name: 'revoked', ok: true })
    const revokeCall = fetchCalls.find((c) => c.path === '/set/api/apply')
    expect(revokeCall?.body).toEqual({ op: 'revoke_device', id: 'dev-77' })
    assertNoTokenLeak(report)
  })
})

// ── no token ever appears in output, on every path ──────────────────────
//
// Ruling (fix round 1, item 1): the report/checks are normal CLI output —
// they must never contain a live, never-expiring credential (link, device,
// file, or operator token), on any path. `assertNoTokenLeak` is exercised
// after every scenario above; this section is the single place documenting
// that contract for anyone adding a new check later.
it('no check on any path ever contains a raw token value', () => {
  // Documented by `assertNoTokenLeak`, called at the end of every scenario
  // test above (remote off, link failure, relay unreachable, pairing
  // limit, v1 device, event timeout, revoke failure — both variants —, and
  // the success path). This assertion just pins the credential list itself
  // so a future rename doesn't silently stop checking anything.
  expect(SECRET_TOKENS).toEqual(['link-tok', 'device-tok', 'file-token', 'op-token'])
})

// ── --relay v2 (push + new Cloudflare relay) ───────────────────────────

interface Harness {
  deps: PhoneSelftestDeps
  /** Extra fetch responses keyed by full URL (e.g. the relay's /healthz). */
  fetchRoutes: Record<string, unknown>
  /** Device-client responses keyed `METHOD /path`. */
  deviceRoutes: Record<string, unknown>
  connectedUrls: string[]
}

function makeHarness(opts: { linkUrl: string }): Harness {
  const fetchRoutes: Record<string, unknown> = {}
  const deviceRoutes: Record<string, unknown> = {}
  const connectedUrls: string[] = []
  let agentsCb: ((data: unknown, meta: { epoch: string; seq: number }) => void) | undefined
  let seq = 0
  const emitAgents = (tasks: Array<{ id: string; title: string; phase: string }>) => {
    seq += 1
    agentsCb?.({ running: tasks.length, waiting: 0, tasks }, { epoch: 'e1', seq })
  }
  const fetchImpl = (async (url: string | URL) => {
    const key = String(url)
    if (key in fetchRoutes) return jsonResponse(200, fetchRoutes[key])
    const u = new URL(key)
    if (u.pathname === '/v1/settings/link') return jsonResponse(200, { url: opts.linkUrl })
    if (u.pathname === '/v1/workbench/create') {
      emitAgents([{ id: 'task-1', title: 'selftest-phone', phase: 'working' }])
      return jsonResponse(202, { task: { id: 'task-1' } })
    }
    if (u.pathname === '/v1/workbench/archive') return jsonResponse(200, { task: { id: 'task-1' } })
    if (u.pathname === '/set/api/apply') return jsonResponse(200, { ok: true })
    throw new Error(`unexpected fetch: ${key}`)
  }) as unknown as typeof fetch
  let deviceClients = 0
  const deps = baseDeps({
    fetch: fetchImpl,
    sleep: async () => { emitAgents([]) },
    connect: (url, token) => {
      connectedUrls.push(url)
      if (token === 'link-tok') {
        return fakeClient({ onRequest: (req) => makeResponse(200, req.path === '/set/api/pair' ? { ok: true, device_token: 'device-tok' } : {}) }).client
      }
      deviceClients++
      if (deviceClients > 1) {
        return { version: () => null, request: async () => { throw new Error('auth_failed') }, subscribe: () => () => {}, close: () => {} }
      }
      return {
        version: () => 2,
        async request(req) {
          if (req.path === '/set/api/state') return makeResponse(200, { remote: { devices: [{ id: 'dev-1', current: true }] } })
          const route = deviceRoutes[`${req.method} ${req.path}`]
          if (route === undefined) throw new Error(`unexpected: ${req.method} ${req.path}`)
          return makeResponse(200, route)
        },
        subscribe(topic, cb) {
          if (topic === 'agents') { agentsCb = cb; emitAgents([]) }
          return () => { agentsCb = undefined }
        },
        close() {},
      }
    },
  })
  return { deps, fetchRoutes, deviceRoutes, connectedUrls }
}

const V2_LINK = 'https://relay.tendhearth.com/pset/#id=rabcdefghijklmnopqrstuvwxyz&t=link-tok&p=%2Fset&lan=192.168.1.2:8080'
const V1_LINK = 'https://cc.tendhearth.com/pset/#id=tdeadbeef&t=link-tok&p=%2Fset&lan=192.168.1.2:8080'

describe('selftest phone --relay v2', () => {
  it('r… id link ⇒ connects /v2/phone, healthz, registers fake APNs token, Apple accepting the JWT is PASS', async () => {
    const h = makeHarness({ linkUrl: V2_LINK })
    h.fetchRoutes['https://relay.tendhearth.com/healthz'] = { ok: true, version: 'x', env: 'production', apns: true, fcm: false }
    h.deviceRoutes['POST /m/api/push/register'] = { ok: true }
    h.deviceRoutes['POST /m/api/push/test'] = { ok: true, result: { ok: false, code: 'BadDeviceToken' } }
    const r = await runPhoneSelftest(h.deps, { executor: 'cursor', relay: 'v2', timeoutMs: 5000 })
    expect(h.connectedUrls[0]).toBe('wss://relay.tendhearth.com/v2/phone?id=rabcdefghijklmnopqrstuvwxyz')
    for (const n of ['relay_v2_link', 'relay_healthz', 'push_registered', 'apns_auth_accepted']) {
      expect(r.checks.find((c) => c.name === n)?.ok, `${n}: ${JSON.stringify(r.checks)}`).toBe(true)
    }
    expect(r.ok).toBe(true)
    assertNoTokenLeak(r)
  })
  it('legacy t… id with --relay v2 ⇒ relay_v2_link FAIL and stops', async () => {
    const h = makeHarness({ linkUrl: V1_LINK })
    const r = await runPhoneSelftest(h.deps, { executor: 'cursor', relay: 'v2' })
    expect(r.checks.find((c) => c.name === 'relay_v2_link')?.ok).toBe(false)
    expect(r.ok).toBe(false)
    expect(h.connectedUrls).toEqual([])
  })
  it('InvalidProviderToken ⇒ apns_auth_accepted FAIL with the code in detail', async () => {
    const h = makeHarness({ linkUrl: V2_LINK })
    h.fetchRoutes['https://relay.tendhearth.com/healthz'] = { ok: true, apns: true }
    h.deviceRoutes['POST /m/api/push/register'] = { ok: true }
    h.deviceRoutes['POST /m/api/push/test'] = { ok: true, result: { ok: false, code: 'InvalidProviderToken' } }
    const r = await runPhoneSelftest(h.deps, { executor: 'cursor', relay: 'v2', timeoutMs: 5000 })
    expect(r.checks.find((c) => c.name === 'apns_auth_accepted')).toMatchObject({ ok: false, detail: expect.stringContaining('InvalidProviderToken') })
  })
  it('healthz without apns ⇒ relay_healthz FAIL', async () => {
    const h = makeHarness({ linkUrl: V2_LINK })
    h.fetchRoutes['https://relay.tendhearth.com/healthz'] = { ok: true, apns: false }
    h.deviceRoutes['POST /m/api/push/register'] = { ok: true }
    h.deviceRoutes['POST /m/api/push/test'] = { ok: true, result: { ok: false, code: 'BadDeviceToken' } }
    const r = await runPhoneSelftest(h.deps, { executor: 'cursor', relay: 'v2', timeoutMs: 5000 })
    expect(r.checks.find((c) => c.name === 'relay_healthz')?.ok).toBe(false)
  })
  it('without --relay: legacy link still uses /tunnel/phone and runs no push checks', async () => {
    const h = makeHarness({ linkUrl: V1_LINK })
    const r = await runPhoneSelftest(h.deps, { executor: 'cursor', timeoutMs: 5000 })
    expect(h.connectedUrls[0]).toBe('wss://cc.tendhearth.com/tunnel/phone?id=tdeadbeef')
    expect(r.checks.some((c) => c.name === 'push_registered' || c.name === 'relay_healthz')).toBe(false)
  })
})
