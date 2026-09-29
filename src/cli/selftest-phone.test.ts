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
  })
})

// ── GET /v1/settings/link failure ───────────────────────────────────

it('settings/link route errors ⇒ FAIL with the http error, no relay attempted', async () => {
  const fetchImpl = (async () => jsonResponse(403, { error: 'route_not_allowed' })) as unknown as typeof fetch
  const deps = baseDeps({ fetch: fetchImpl, connect: () => { throw new Error('must not connect') } })
  const report = await runPhoneSelftest(deps, { executor: 'claude' })
  expect(report.ok).toBe(false)
  expect(report.checks[0]).toEqual({ name: 'link_url', ok: false, detail: 'http_403 route_not_allowed' })
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
  })
})

// ── revoke failure ─────────────────────────────────────────────────────

describe('revoke failure', () => {
  it('LAN /set/api/apply revoke_device fails ⇒ revoked ✗ with the exact manual curl command, overall FAIL', async () => {
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
    expect(revoked?.detail).toContain('manual revoke:')
    expect(revoked?.detail).toContain("curl -X POST 'http://192.168.1.5:51234/set/api/apply?t=device-tok'")
    expect(revoked?.detail).toContain('"op":"revoke_device"')
    expect(revoked?.detail).toContain('"id":"dev-7"')
    // A failed revoke must not claim the follow-up auth_failed check passed.
    expect(report.checks.find((c) => c.name === 'revoked_auth_failed')).toBeUndefined()
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
  })
})
