/**
 * selftest-phone — `wechat-cc selftest phone` (spec
 * docs/superpowers/plans/2026-09-29-phone-protocol-v2.md Task 13).
 *
 * A real-machine closed loop for the phone protocol: read the daemon's
 * link URL (`GET /v1/settings/link`, admin tier ⇒ operator token), connect to the real relay with the
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
const SYNTHETIC_APNS_TOKEN = '0'.repeat(64)
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

/** Strips the `t=` credential from a link URL before it's ever put in a
 *  check's detail. Both link shapes carry it — as a fragment param on the
 *  remote/relay shape, as a query param on the LAN-only shape — and it's a
 *  live, never-expiring token: it must never land in normal CLI output
 *  (ruling, fix round 1 item 1). Keeps everything else (host, daemon id,
 *  LAN address) for debugging. */
export function redactLinkUrl(raw: string): string {
  try {
    const u = new URL(raw)
    if (u.searchParams.has('t')) u.searchParams.set('t', '<redacted>')
    if (u.hash) {
      const frag = new URLSearchParams(u.hash.slice(1))
      if (frag.has('t')) { frag.set('t', '<redacted>'); u.hash = frag.toString() }
    }
    return u.toString()
  } catch {
    return raw
  }
}

/**
 * The only manual-recovery instruction this module ever prints — it must
 * never embed a token (ruling, fix round 1 item 1: not even in a ready-to-
 * paste curl command). It identifies the throwaway paired device by id
 * when known, falling back to its pairing time (item 2's "both LAN and
 * relay lookups failed" case) — the device token itself never appears.
 */
function manualRevokeInstruction(who: { id?: string; pairedAt?: number }): string {
  let target: string
  if (who.id) {
    target = `the device with id ${who.id}`
    if (who.pairedAt !== undefined) target += ` (paired ${new Date(who.pairedAt).toISOString()})`
  } else if (who.pairedAt !== undefined) {
    target = `the device paired at ${new Date(who.pairedAt).toISOString()}`
  } else {
    target = 'the throwaway paired device'
  }
  return `open the settings page (/set, e.g. via 「设置」 in WeChat or the desktop QR) → 已配对设备 → 忘掉 ${target}`
}

// ── central redaction: the one place every check detail passes through ──

/**
 * Removes every known secret plus any `t=`/`d=` query value from `text`.
 *
 * Fix round 2 ruling: a bubbled fetch/WebSocket/protocol-client error can
 * legitimately embed the full request URL (Bun/undici commonly do this —
 * "Failed to parse URL from <url>", connection-refused messages, and so
 * on), and every LAN call in this module puts the device token in that
 * URL's `t=` query param. Redacting only at the few call sites we thought
 * of is exactly the failure mode that missed this the first time; instead
 * every string is swept for (a) every token value this run has learned
 * about so far and (b) any `t=`/`d=` query value at all, even for a token
 * this run hasn't registered — belt-and-suspenders for a token embedded in
 * a URL we didn't anticipate.
 */
function sanitize(secrets: ReadonlySet<string>, text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  let out = text
  for (const secret of secrets) if (secret) out = out.split(secret).join('<redacted>')
  out = out.replace(/([?&](?:t|d)=)[^&\s'"]+/g, '$1<redacted>')
  return out
}

/**
 * The single point every check detail is recorded through — sanitizing
 * here (rather than at each call site: `jsonCall`, `httpErrorDetail`, the
 * protocol client's rejection messages, …) is what makes the "no token
 * ever reaches output" guarantee hold regardless of which helper built the
 * string or which future call site starts surfacing a new kind of error.
 */
function makeCheckRecorder(checks: PhoneSelftestCheck[]) {
  const secrets = new Set<string>()
  return {
    /** Registers a credential value as soon as it's known, so any check
     *  recorded from this point on has it redacted. */
    knownSecret(value: string | undefined): void {
      if (value) secrets.add(value)
    },
    push(name: string, ok: boolean, detail?: string): void {
      checks.push({ name, ok, detail: sanitize(secrets, detail) })
    },
  }
}

// ── link URL parsing (settings-panel.ts's two shapes) ─────────────────

export interface RemoteLink { relayWsUrl: string; linkToken: string; lanBase: string; host: string; daemonId: string }

/**
 * `GET /v1/settings/link`'s `url` comes in two shapes (settings-panel.ts
 * `linkUrl()`):
 *   - remote enabled: `https://<relay-host>/pset/#id=<daemonId>&t=<linkToken>&p=/set&lan=<ip>:<port>`
 *   - remote disabled: `http://<ip>:<port>/set?t=<linkToken>` (no relay to test against)
 */
/** 也给 scripts/device-e2e.ts(真机全自动验收)用:同一个链接形状判定,不再抄一份。 */
export function classifyLink(raw: string): { kind: 'remote'; link: RemoteLink } | { kind: 'lan_only' } | { kind: 'invalid'; detail: string } {
  let u: URL
  try { u = new URL(raw) } catch { return { kind: 'invalid', detail: 'unparseable link url' } }
  if (u.hash) {
    const frag = new URLSearchParams(u.hash.slice(1))
    const daemonId = frag.get('id')
    const linkToken = frag.get('t')
    const lan = frag.get('lan')
    if (daemonId && linkToken && lan) {
      // `r…` ids belong to the Cloudflare relay v2; `t…` to the legacy relay.
      const path = daemonId.startsWith('r') ? '/v2/phone' : '/tunnel/phone'
      return { kind: 'remote', link: { relayWsUrl: `wss://${u.host}${path}?id=${encodeURIComponent(daemonId)}`, linkToken, lanBase: `http://${lan}`, host: u.host, daemonId } }
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
  opts: { executor: string; timeoutMs?: number; relay?: 'v2' },
): Promise<PhoneSelftestReport> {
  const start = deps.now()
  const api = deps.readApiInfo()
  if (!api) throw new Error('daemon_not_running')

  const checks: PhoneSelftestCheck[] = []
  const rec = makeCheckRecorder(checks)
  rec.knownSecret(api.token)
  rec.knownSecret(api.operatorToken)
  const report: PhoneSelftestReport = { ok: false, kind: 'phone', target: opts.executor, checks, durationMs: 0 }
  const deadline = start + (opts.timeoutMs ?? DEFAULT_PHONE_TIMEOUT_MS)

  let linkClient: ProtocolClient | undefined
  let deviceClient: ProtocolClient | undefined
  let unsubscribe: (() => void) | undefined
  let relayWsUrl: string | undefined
  let deviceToken: string | undefined
  let deviceId: string | undefined
  let pairedAt: number | undefined
  let lanBase: string | undefined
  let taskId: string | undefined
  let scratchPath: string | undefined
  let revoked = false
  const agentEvents: AgentsEvent[] = []

  try {
    // ── link URL + relay address ─────────────────────────────────────
    // admin 档(plan 7a):铸 admin 链接令牌,共享的 trusted 文件 token 够不着 ⇒ 用 operator 凭据。
    const linkRes = await jsonCall(deps, `${api.baseUrl}/v1/settings/link`, api.operatorToken, 'GET')
    const url = linkRes.ok && typeof linkRes.json?.url === 'string' ? linkRes.json.url as string : undefined
    rec.push('link_url', !!url, url ? redactLinkUrl(url) : httpErrorDetail(linkRes))
    if (!url) stop()

    const cls = classifyLink(url)
    if (cls.kind === 'lan_only') {
      rec.push('remote_enabled', false, 'remote access is off — enable 出门也能用 in settings')
      stop()
    }
    if (cls.kind === 'invalid') {
      rec.push('link_url_shape', false, cls.detail)
      stop()
    }
    rec.push('remote_enabled', true)
    if (opts.relay === 'v2') {
      const isV2 = cls.link.daemonId.startsWith('r')
      rec.push('relay_v2_link', isV2, isV2 ? undefined : 'link still points at the legacy relay (t… id) — is relay_v2_url set and the daemon redeployed?')
      if (!isV2) stop()
      const hz = await jsonCall(deps, `https://${cls.link.host}/healthz`, null, 'GET')
      const hzOk = hz.ok && hz.json?.ok === true && hz.json?.apns === true
      rec.push('relay_healthz', hzOk, hzOk ? undefined : `healthz: ${JSON.stringify(hz.json ?? httpErrorDetail(hz))}`)
    }
    relayWsUrl = cls.link.relayWsUrl
    lanBase = cls.link.lanBase
    rec.knownSecret(cls.link.linkToken)

    // ── pair with the link token over the real relay ───────────────────
    linkClient = deps.connect(relayWsUrl, cls.link.linkToken)
    let pairJson: { ok?: boolean; device_token?: string; error?: string } = {}
    try {
      const pairRes = await linkClient.request({ method: 'POST', path: '/set/api/pair', body: '{}' })
      try { pairJson = pairRes.json() } catch { pairJson = {} }
    } catch (err) {
      rec.push('paired', false, `relay unreachable: ${err instanceof Error ? err.message : String(err)}`)
      stop()
    }
    if (!pairJson.ok || !pairJson.device_token) {
      rec.push('paired', false, pairJson.error ?? 'pair failed')
      stop()
    }
    rec.push('paired', true)
    deviceToken = pairJson.device_token
    rec.knownSecret(deviceToken)
    pairedAt = deps.now()

    // ── connect with the device token; confirm v2, fetch its device id ─
    deviceClient = deps.connect(relayWsUrl, deviceToken!)
    let stateJson: { remote?: { devices?: Array<{ id?: string; current?: boolean }> } } = {}
    try {
      const stateRes = await deviceClient.request({ method: 'GET', path: '/set/api/state' })
      try { stateJson = stateRes.json() } catch { stateJson = {} }
    } catch (err) {
      rec.push('device_connected', false, err instanceof Error ? err.message : String(err))
      stop()
    }
    const version = deviceClient.version()
    rec.push('device_v2', version === 2, version === 2 ? undefined : 'daemon is not v2')
    const current = stateJson.remote?.devices?.find((d) => d.current)
    deviceId = typeof current?.id === 'string' ? current.id : undefined
    rec.push('device_id', !!deviceId, deviceId ?? 'no current device in remote.devices')
    if (version !== 2 || !deviceId) stop()

    if (opts.relay === 'v2') {
      let regOk = false, code = 'no_response'
      rec.knownSecret(SYNTHETIC_APNS_TOKEN)
      try {
        const reg = await deviceClient.request({ method: 'POST', path: '/m/api/push/register', body: JSON.stringify({ platform: 'apns', token: SYNTHETIC_APNS_TOKEN }) })
        regOk = reg.json<{ ok?: boolean }>().ok === true
        rec.push('push_registered', regOk, regOk ? undefined : reg.text())
        if (regOk) {
          const t = await deviceClient.request({ method: 'POST', path: '/m/api/push/test', body: '{}' })
          code = t.json<{ result?: { code?: string } }>().result?.code ?? 'no_result'
        }
      } catch (err) {
        rec.push('push_registered', false, err instanceof Error ? err.message : String(err))
      }
      if (regOk) {
        const accepted = code === 'BadDeviceToken' || code === 'DeviceTokenNotForTopic'
        rec.push('apns_auth_accepted', accepted, accepted ? `APNs rejected the synthetic token with ${code} — auth OK` : `APNs said ${code}`)
      }
    }

    // ── subscribe agents, drive one minimal task, watch it arrive+finish ─
    unsubscribe = deviceClient.subscribe('agents', (data, meta) => { agentEvents.push({ data, epoch: meta.epoch, seq: meta.seq }) })
    const gotSnapshot = await waitUntil(deps, deadline, () => agentEvents.length > 0)
    rec.push('agents_subscribed', gotSnapshot, gotSnapshot ? undefined : 'timeout waiting for initial agents snapshot')
    if (!gotSnapshot) stop()

    scratchPath = join(deps.scratchRoot, `phone-${deps.now()}`)
    deps.fs.mkdir(scratchPath)
    const createRes = await jsonCall(deps, `${api.baseUrl}/v1/workbench/create`, api.operatorToken, 'POST', {
      path: scratchPath, providerId: opts.executor, title: 'selftest-phone', text: MINIMAL_TASK_TEXT,
    })
    taskId = createRes.ok && createRes.json?.task?.id ? String(createRes.json.task.id) : undefined
    rec.push('task_created', !!taskId, taskId ?? httpErrorDetail(createRes))
    if (!taskId) stop()

    const seen = await waitUntil(deps, deadline, () => hasTask(agentEvents.at(-1), taskId!))
    rec.push('agents_task_seen', seen, seen ? undefined : 'timeout waiting for the task in the agents feed')
    if (!seen) stop()

    const done = await waitUntil(deps, deadline, () => !hasTask(agentEvents.at(-1), taskId!))
    rec.push('agents_task_terminal', done, done ? undefined : 'timeout waiting for the task to leave the agents feed')

    const ordered = agentsEventOrderOk(agentEvents)
    rec.push('agents_event_order', ordered, ordered ? undefined : 'out-of-order agents event (seq did not increase within an epoch)')
  } catch (err) {
    if (!(err instanceof PhoneSelftestStop)) rec.push('internal_error', false, err instanceof Error ? err.message : String(err))
  } finally {
    if (unsubscribe) { try { unsubscribe() } catch { /* best-effort */ } }
    if (taskId) {
      const archiveRes = await jsonCall(deps, `${api.baseUrl}/v1/workbench/archive`, api.operatorToken, 'POST', { id: taskId, archived: true })
      rec.push('archived', archiveRes.ok, archiveRes.ok ? undefined : httpErrorDetail(archiveRes))
    }
    if (scratchPath) { try { deps.fs.rm(scratchPath) } catch { /* best-effort */ } }

    if (deviceToken && lanBase) {
      // The relay-based probe (above) may have failed to establish a
      // device id at all (e.g. `/set/api/state` over the relay threw) —
      // ruling, fix round 1 item 2: don't just print prose, try to recover
      // it over the LAN first, then revoke there as usual. Only if THAT
      // also fails do we fall back to the manual settings-page instruction.
      let idToRevoke = deviceId
      if (!idToRevoke) {
        const lanStateRes = await jsonCall(deps, `${lanBase}/set/api/state?t=${encodeURIComponent(deviceToken)}`, null, 'GET')
        const lanState = lanStateRes.json as { remote?: { devices?: Array<{ id?: string; current?: boolean }> } } | null
        const lanCurrent = lanState?.remote?.devices?.find((d) => d?.current)
        if (typeof lanCurrent?.id === 'string') idToRevoke = lanCurrent.id
      }
      if (idToRevoke) {
        deviceId = idToRevoke
        const revokeRes = await jsonCall(deps, `${lanBase}/set/api/apply?t=${encodeURIComponent(deviceToken)}`, null, 'POST', { op: 'revoke_device', id: idToRevoke })
        revoked = !!revokeRes.json?.ok
        if (revoked) {
          rec.push('revoked', true)
        } else {
          rec.push('revoked', false, `${revokeRes.json?.error ?? httpErrorDetail(revokeRes)} — ${manualRevokeInstruction({ id: idToRevoke, pairedAt })}`)
        }
      } else {
        rec.push('revoked', false, `could not determine the device id to revoke (relay and LAN /set/api/state both failed) — ${manualRevokeInstruction({ pairedAt })}`)
      }
    } else if (deviceToken) {
      // Defensive fallback — `lanBase` is always set alongside `deviceToken`
      // (both come from the same successful 'remote' link classification
      // that precedes pairing), so this branch shouldn't be reachable.
      rec.push('revoked', false, manualRevokeInstruction({ pairedAt }))
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
      rec.push('revoked_auth_failed', authFailed, detail)
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
