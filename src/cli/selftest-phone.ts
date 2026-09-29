/**
 * selftest-phone — `wechat-cc selftest phone` (spec
 * docs/superpowers/plans/2026-09-29-phone-protocol-v2.md Task 13).
 *
 * A real-machine closed loop for the phone protocol: read the daemon's
 * link URL (`GET /v1/settings/link`), connect to the real relay with the
 * link token, pair a throwaway device, connect with the device token and
 * confirm it negotiates protocol v2, subscribe to the `agents` topic, drive
 * one minimal workbench task through the operator (internal) API and
 * confirm its lifecycle shows up on the subscription, then revoke the
 * device over the LAN and confirm the revoked token can no longer connect.
 *
 * Kept in its own file (not `selftest.ts`, already 668 lines): the only
 * change to `selftest.ts`/`commands/selftest.ts` is the subcommand wiring
 * in the latter. `runPhoneSelftest` takes an injected `PhoneSelftestDeps`
 * (fetch, clock, sleep, fs, and — the protocol-specific seam — `connect`,
 * which hands back a `ProtocolClient` for a relay URL + token). Tests fake
 * `connect` directly at the `ProtocolClient` level; they don't re-simulate
 * the wire protocol's crypto, that's `packages/protocol`'s own test suite's
 * job. `defaultPhoneSelftestDeps` wires the real thing: a small adapter
 * from the global `WebSocket` (Bun has it at runtime; the compiled sidecar
 * runs on Bun) to `ProtocolSocket`, feeding `makeProtocolClient`.
 */
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeProtocolClient, type ProtocolClient, type ProtocolSocket } from '@wechat-cc/protocol'
import { readApiInfo } from '../lib/api-info'

export interface PhoneSelftestCheck { name: string; ok: boolean; detail?: string }
export interface PhoneSelftestReport {
  ok: boolean
  kind: 'phone'
  target: string
  checks: PhoneSelftestCheck[]
  taskId?: string
  durationMs: number
}

export interface PhoneSelftestDeps {
  fetch: typeof globalThis.fetch
  readApiInfo: () => { baseUrl: string; token: string; operatorToken: string } | null
  /** Where the scratch workbench project lives. Same reasoning as
   *  `SelftestDeps.scratchRoot` in `selftest.ts`: deliberately NOT
   *  STATE_DIR. Real runs use `<os.tmpdir()>/wechat-cc-selftest`. */
  scratchRoot: string
  fs: { mkdir(p: string): void; rm(p: string): void }
  now: () => number
  sleep: (ms: number) => Promise<void>
  /** Opens a protocol client to the relay at `url`, authenticated with
   *  `token` (a link token or a device token — the wire protocol binds the
   *  token into the handshake's derived keys, see `client.ts`). */
  connect: (url: string, token: string) => ProtocolClient
  log: (line: string) => void
}

export const PHONE_SELFTEST_EXIT = { ok: 0, failed: 1, noDaemon: 2 } as const

const DEFAULT_PHONE_TIMEOUT_MS = 90_000
const FETCH_TIMEOUT_MS = 15_000
const POLL_INTERVAL_MS = 200
const MINIMAL_TASK_TEXT = '这是 wechat-cc 手机自检的最小工作台任务：不要使用任何工具，直接回复一句「已收到」然后结束。'

// ── plain HTTP calls (internal API + the LAN-only revoke) ─────────────

interface HttpResult { ok: boolean; status: number; json: any }

async function jsonCall(deps: PhoneSelftestDeps, url: string, bearer: string | null, method: string, body?: unknown): Promise<HttpResult> {
  try {
    const res = await deps.fetch(url, {
      method,
      headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), 'content-type': 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    let json: any = null
    try { json = await res.json() } catch { /* body optional */ }
    return { ok: res.ok, status: res.status, json }
  } catch (err) {
    return { ok: false, status: 0, json: { error: err instanceof Error ? err.message : String(err) } }
  }
}

function httpErrorDetail(res: HttpResult): string {
  const parts = [`http_${res.status}`]
  const err = res.json?.error
  if (typeof err === 'string' && err) parts.push(err)
  return parts.join(' ')
}

// ── link URL parsing (settings-panel.ts's two shapes) ─────────────────

interface RemoteLink { relayWsUrl: string; linkToken: string; lanBase: string }

/**
 * `GET /v1/settings/link`'s `url` comes in two shapes (settings-panel.ts
 * `linkUrl()`):
 *   - remote enabled: `https://<relay-host>/pset/#id=<daemonId>&t=<linkToken>&p=/set&lan=<ip>:<port>`
 *   - remote disabled: `http://<ip>:<port>/set?t=<linkToken>` (no relay to test against)
 */
function classifyLink(raw: string): { kind: 'remote'; link: RemoteLink } | { kind: 'lan_only' } | { kind: 'invalid'; detail: string } {
  let u: URL
  try { u = new URL(raw) } catch { return { kind: 'invalid', detail: 'unparseable link url' } }
  if (u.hash) {
    const frag = new URLSearchParams(u.hash.slice(1))
    const daemonId = frag.get('id')
    const linkToken = frag.get('t')
    const lan = frag.get('lan')
    if (daemonId && linkToken && lan) {
      return { kind: 'remote', link: { relayWsUrl: `wss://${u.host}/tunnel/phone?id=${encodeURIComponent(daemonId)}`, linkToken, lanBase: `http://${lan}` } }
    }
  }
  if (u.protocol === 'http:' && u.searchParams.get('t')) return { kind: 'lan_only' }
  return { kind: 'invalid', detail: 'unrecognized link url shape' }
}

// ── control flow: abandon the remaining checks, cleanup still runs ────

class PhoneSelftestStop extends Error {}
function stop(): never { throw new PhoneSelftestStop('phone selftest stopped early') }

async function waitUntil(deps: PhoneSelftestDeps, deadline: number, predicate: () => boolean): Promise<boolean> {
  for (;;) {
    if (predicate()) return true
    if (deps.now() >= deadline) return predicate()
    await deps.sleep(POLL_INTERVAL_MS)
  }
}

interface AgentsEvent { data: any; epoch: string; seq: number }

function agentsEventOrderOk(events: AgentsEvent[]): boolean {
  for (let i = 1; i < events.length; i++) {
    const prev = events[i - 1]!, cur = events[i]!
    if (cur.epoch === prev.epoch && cur.seq <= prev.seq) return false
  }
  return true
}

function hasTask(ev: AgentsEvent | undefined, taskId: string): boolean {
  const tasks = ev?.data?.tasks
  return Array.isArray(tasks) && tasks.some((t: any) => t?.id === taskId)
}

export async function runPhoneSelftest(
  deps: PhoneSelftestDeps,
  opts: { executor: string; timeoutMs?: number },
): Promise<PhoneSelftestReport> {
  const start = deps.now()
  const api = deps.readApiInfo()
  if (!api) throw new Error('daemon_not_running')

  const checks: PhoneSelftestCheck[] = []
  const report: PhoneSelftestReport = { ok: false, kind: 'phone', target: opts.executor, checks, durationMs: 0 }
  const deadline = start + (opts.timeoutMs ?? DEFAULT_PHONE_TIMEOUT_MS)

  let linkClient: ProtocolClient | undefined
  let deviceClient: ProtocolClient | undefined
  let unsubscribe: (() => void) | undefined
  let relayWsUrl: string | undefined
  let deviceToken: string | undefined
  let deviceId: string | undefined
  let lanBase: string | undefined
  let taskId: string | undefined
  let scratchPath: string | undefined
  let revoked = false
  const agentEvents: AgentsEvent[] = []

  try {
    // ── link URL + relay address ─────────────────────────────────────
    const linkRes = await jsonCall(deps, `${api.baseUrl}/v1/settings/link`, api.token, 'GET')
    const url = linkRes.ok && typeof linkRes.json?.url === 'string' ? linkRes.json.url as string : undefined
    checks.push({ name: 'link_url', ok: !!url, detail: url ?? httpErrorDetail(linkRes) })
    if (!url) stop()

    const cls = classifyLink(url)
    if (cls.kind === 'lan_only') {
      checks.push({ name: 'remote_enabled', ok: false, detail: 'remote access is off — enable 出门也能用 in settings' })
      stop()
    }
    if (cls.kind === 'invalid') {
      checks.push({ name: 'link_url_shape', ok: false, detail: cls.detail })
      stop()
    }
    checks.push({ name: 'remote_enabled', ok: true })
    relayWsUrl = cls.link.relayWsUrl
    lanBase = cls.link.lanBase

    // ── pair with the link token over the real relay ───────────────────
    linkClient = deps.connect(relayWsUrl, cls.link.linkToken)
    let pairJson: { ok?: boolean; device_token?: string; error?: string } = {}
    try {
      const pairRes = await linkClient.request({ method: 'POST', path: '/set/api/pair', body: '{}' })
      try { pairJson = pairRes.json() } catch { pairJson = {} }
    } catch (err) {
      checks.push({ name: 'paired', ok: false, detail: `relay unreachable: ${err instanceof Error ? err.message : String(err)}` })
      stop()
    }
    if (!pairJson.ok || !pairJson.device_token) {
      checks.push({ name: 'paired', ok: false, detail: pairJson.error ?? 'pair failed' })
      stop()
    }
    checks.push({ name: 'paired', ok: true })
    deviceToken = pairJson.device_token

    // ── connect with the device token; confirm v2, fetch its device id ─
    deviceClient = deps.connect(relayWsUrl, deviceToken!)
    let stateJson: { remote?: { devices?: Array<{ id?: string; current?: boolean }> } } = {}
    try {
      const stateRes = await deviceClient.request({ method: 'GET', path: '/set/api/state' })
      try { stateJson = stateRes.json() } catch { stateJson = {} }
    } catch (err) {
      checks.push({ name: 'device_connected', ok: false, detail: err instanceof Error ? err.message : String(err) })
      stop()
    }
    const version = deviceClient.version()
    checks.push({ name: 'device_v2', ok: version === 2, detail: version === 2 ? undefined : 'daemon is not v2' })
    const current = stateJson.remote?.devices?.find((d) => d.current)
    deviceId = typeof current?.id === 'string' ? current.id : undefined
    checks.push({ name: 'device_id', ok: !!deviceId, detail: deviceId ?? 'no current device in remote.devices' })
    if (version !== 2 || !deviceId) stop()

    // ── subscribe agents, drive one minimal task, watch it arrive+finish ─
    unsubscribe = deviceClient.subscribe('agents', (data, meta) => { agentEvents.push({ data, epoch: meta.epoch, seq: meta.seq }) })
    const gotSnapshot = await waitUntil(deps, deadline, () => agentEvents.length > 0)
    checks.push({ name: 'agents_subscribed', ok: gotSnapshot, detail: gotSnapshot ? undefined : 'timeout waiting for initial agents snapshot' })
    if (!gotSnapshot) stop()

    scratchPath = join(deps.scratchRoot, `phone-${deps.now()}`)
    deps.fs.mkdir(scratchPath)
    const createRes = await jsonCall(deps, `${api.baseUrl}/v1/workbench/create`, api.operatorToken, 'POST', {
      path: scratchPath, providerId: opts.executor, title: 'selftest-phone', text: MINIMAL_TASK_TEXT,
    })
    taskId = createRes.ok && createRes.json?.task?.id ? String(createRes.json.task.id) : undefined
    checks.push({ name: 'task_created', ok: !!taskId, detail: taskId ?? httpErrorDetail(createRes) })
    if (!taskId) stop()

    const seen = await waitUntil(deps, deadline, () => hasTask(agentEvents.at(-1), taskId!))
    checks.push({ name: 'agents_task_seen', ok: seen, detail: seen ? undefined : 'timeout waiting for the task in the agents feed' })
    if (!seen) stop()

    const done = await waitUntil(deps, deadline, () => !hasTask(agentEvents.at(-1), taskId!))
    checks.push({ name: 'agents_task_terminal', ok: done, detail: done ? undefined : 'timeout waiting for the task to leave the agents feed' })

    checks.push({ name: 'agents_event_order', ok: agentsEventOrderOk(agentEvents), detail: agentsEventOrderOk(agentEvents) ? undefined : 'out-of-order agents event (seq did not increase within an epoch)' })
  } catch (err) {
    if (!(err instanceof PhoneSelftestStop)) checks.push({ name: 'internal_error', ok: false, detail: err instanceof Error ? err.message : String(err) })
  } finally {
    if (unsubscribe) { try { unsubscribe() } catch { /* best-effort */ } }
    if (taskId) {
      const archiveRes = await jsonCall(deps, `${api.baseUrl}/v1/workbench/archive`, api.operatorToken, 'POST', { id: taskId, archived: true })
      checks.push({ name: 'archived', ok: archiveRes.ok, detail: archiveRes.ok ? undefined : httpErrorDetail(archiveRes) })
    }
    if (scratchPath) { try { deps.fs.rm(scratchPath) } catch { /* best-effort */ } }

    if (deviceToken && lanBase && deviceId) {
      const revokeUrl = `${lanBase}/set/api/apply?t=${encodeURIComponent(deviceToken)}`
      const revokeBody = { op: 'revoke_device', id: deviceId }
      const revokeRes = await jsonCall(deps, revokeUrl, null, 'POST', revokeBody)
      revoked = !!revokeRes.json?.ok
      if (revoked) {
        checks.push({ name: 'revoked', ok: true })
      } else {
        const manualCmd = `curl -X POST '${revokeUrl}' -H 'content-type: application/json' -d '${JSON.stringify(revokeBody)}'`
        checks.push({ name: 'revoked', ok: false, detail: `${revokeRes.json?.error ?? httpErrorDetail(revokeRes)} — manual revoke: ${manualCmd}` })
      }
    } else if (deviceToken) {
      checks.push({ name: 'revoked', ok: false, detail: 'no device id — could not revoke the paired throwaway device; check remote.devices on /set and revoke it by hand' })
    }

    if (revoked && relayWsUrl && deviceToken) {
      const freshClient = deps.connect(relayWsUrl, deviceToken)
      let authFailed = false, detail: string | undefined
      try {
        await freshClient.request({ method: 'GET', path: '/set/api/state' })
        detail = 'request succeeded — revoked token still works'
      } catch (err) {
        authFailed = err instanceof Error && err.message === 'auth_failed'
        detail = authFailed ? undefined : (err instanceof Error ? err.message : String(err))
      } finally {
        try { freshClient.close() } catch { /* best-effort */ }
      }
      checks.push({ name: 'revoked_auth_failed', ok: authFailed, detail })
    }

    if (deviceClient) { try { deviceClient.close() } catch { /* best-effort */ } }
    if (linkClient) { try { linkClient.close() } catch { /* best-effort */ } }
  }

  if (taskId) report.taskId = taskId
  report.ok = checks.length > 0 && checks.every((c) => c.ok)
  report.durationMs = deps.now() - start
  return report
}

// ── human/JSON output ───────────────────────────────────────────────

export function formatPhoneSelftestReport(r: PhoneSelftestReport): string {
  const lines = r.checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`)
  lines.push(r.ok ? 'PASS' : 'FAIL')
  return lines.join('\n')
}

// ── real deps (used by cli.ts) ──────────────────────────────────────

/** Minimal adapter from the global `WebSocket` (Bun/browser-shaped) to the
 *  protocol package's `ProtocolSocket`. */
function adaptWebSocket(ws: WebSocket): ProtocolSocket {
  return {
    send: (s) => ws.send(s),
    close: () => { try { ws.close() } catch { /* already closed */ } },
    onOpen: (cb) => { ws.onopen = () => cb() },
    onMessage: (cb) => { ws.onmessage = (ev) => cb(String(ev.data)) },
    onClose: (cb) => { ws.onclose = () => cb() },
  }
}

export function defaultPhoneSelftestDeps(stateDir: string): PhoneSelftestDeps {
  return {
    fetch,
    readApiInfo: () => readApiInfo(stateDir),
    // NOT under STATE_DIR — same reasoning as selftest.ts's defaultSelftestDeps.
    scratchRoot: join(tmpdir(), 'wechat-cc-selftest'),
    fs: {
      mkdir: (p) => mkdirSync(p, { recursive: true }),
      rm: (p) => { try { rmSync(p, { recursive: true, force: true }) } catch { /* best-effort */ } },
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    connect: (url, token) => makeProtocolClient({ open: () => adaptWebSocket(new WebSocket(url)), token }),
    log: (line) => console.error(`[selftest] ${line}`),
  }
}
