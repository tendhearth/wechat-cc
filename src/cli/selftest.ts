/**
 * selftest — `wechat-cc selftest workbench|chat` (spec
 * docs/superpowers/specs/2026-09-18-self-maintenance-design.md §2).
 *
 * A real-machine closed loop a maintainer (human or LLM) can run after
 * `self deploy` to get a machine-readable PASS/FAIL instead of hand-rolled
 * smoke scripts: drive one workbench task (or one `POST
 * /v1/selftest/converse` turn) through the real daemon over its operator
 * token, and report which of the expected signals actually showed up.
 *
 * Two purely-testable entry points — `runWorkbenchSelftest` /
 * `runChatSelftest` — take an injected `SelftestDeps` (fetch, clock, sleep,
 * a tiny fs surface, an optional `git`, a logger). `cli.ts` only parses
 * flags, builds the real deps (`defaultSelftestDeps`), and prints/exits.
 */
import { randomUUID } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { readJsonFile } from '../lib/read-json-file'

export interface SelftestCheck { name: string; ok: boolean; detail?: string }
export interface SelftestReport {
  ok: boolean
  kind: 'workbench' | 'chat'
  target: string
  checks: SelftestCheck[]
  taskId?: string
  sessionId?: string
  durationMs: number
  scratchPath?: string
}
export interface SelftestDeps {
  fetch: typeof globalThis.fetch
  readApiInfo: () => { baseUrl: string; token: string; operatorToken: string } | null
  stateDir: string
  now: () => number
  sleep: (ms: number) => Promise<void>
  fs: { mkdir(p: string): void; write(p: string, text: string | Uint8Array): void; read(p: string): string | null; rm(p: string): void }
  git?: (args: string[], cwd: string) => boolean
  log: (line: string) => void
}

export const SELFTEST_EXIT = { ok: 0, failed: 1, noDaemon: 2 } as const

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'interrupted'])
const DEFAULT_WORKBENCH_TIMEOUT_MS = 240_000
const DEFAULT_CHAT_TIMEOUT_MS = 120_000
const DEFAULT_CREATE_TEXT = '先运行 shell 命令 `uname -a` 并把输出原样告诉我，然后在项目里新建 hello.txt，内容一行 hello，然后结束。'
const DEFAULT_IMAGE_TEXT = '附带的图片里画的是什么颜色的方块？只回答颜色，不要做别的。'
const DEFAULT_CHAT_TEXT = '调用 wechat 这个 MCP 服务器上的 ping 工具，把它返回的 daemon_pid 数字告诉我，不要做别的。'
const RESUME_WORKBENCH_TEXT = '我上一句让你做的第一件事是什么？只回答一句。'
const RESUME_CHAT_TEXT = '我上一句让你调用的工具叫什么？只回答工具名。'
/** Applied to every daemon call so a hung connection can never sit outside
 *  --timeout-ms's budget (review fix: a stuck socket used to be able to
 *  block the whole run indefinitely). */
const FETCH_TIMEOUT_MS = 30_000
/** If a `GET /v1/workbench/task` long-poll returns near-instantly (the
 *  server had nothing to wait on), pause briefly before the next poll so a
 *  quiet task can't turn into a tight loop. */
const POLL_MIN_INTERVAL_MS = 250
const POLL_IDLE_SLEEP_MS = 1_000
/** Once we decide to cancel a still-running task (see `runWorkbenchSelftest`
 *  finalize step), don't wait longer than this for it to actually stop. */
const CANCEL_WAIT_MS = 20_000

// ── red square PNG (spec §2 step 2: 120×120, RGB, no external image lib) ──

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf: Uint8Array): number {
  let crc = 0xffffffff
  for (const b of buf) crc = CRC_TABLE[(crc ^ b) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

/** 120×120 RGB PNG: a solid red (220,30,30) square on white, no dependency
 *  beyond `node:zlib`'s `deflateSync` for the IDAT stream. */
export function redSquarePng(size = 120): Uint8Array {
  const w = size, h = size
  const lo = Math.floor(size * 0.25), hi = Math.floor(size * 0.75)
  const stride = w * 3 + 1
  const raw = new Uint8Array(stride * h)
  for (let y = 0; y < h; y++) {
    const rowStart = y * stride
    raw[rowStart] = 0 // filter type: none
    const inRow = y >= lo && y < hi
    for (let x = 0; x < w; x++) {
      const o = rowStart + 1 + x * 3
      if (inRow && x >= lo && x < hi) { raw[o] = 220; raw[o + 1] = 30; raw[o + 2] = 30 }
      else { raw[o] = 255; raw[o + 1] = 255; raw[o + 2] = 255 }
    }
  }
  const ihdr = new Uint8Array(13)
  const idv = new DataView(ihdr.buffer)
  idv.setUint32(0, w)
  idv.setUint32(4, h)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: RGB
  // ihdr[10..12] (compression, filter, interlace) already zero.
  const idat = new Uint8Array(deflateSync(raw))
  const chunks = [pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', new Uint8Array(0))]
  const total = PNG_SIGNATURE.length + chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  out.set(PNG_SIGNATURE, 0)
  let off = PNG_SIGNATURE.length
  for (const c of chunks) { out.set(c, off); off += c.length }
  return out
}

// ── daemon HTTP calls (operator token; never throws) ──────────────────

interface ApiCtx { baseUrl: string; operatorToken: string }

interface ApiResult { ok: boolean; status: number; json: any }

async function apiCall(deps: SelftestDeps, api: ApiCtx, method: string, path: string, body?: unknown): Promise<ApiResult> {
  try {
    const res = await deps.fetch(`${api.baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${api.operatorToken}`, 'content-type': 'application/json' },
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

/** `http_<status> <server error>[ <message>]` — surfaces whatever the route
 *  actually said (e.g. `http_428 unattended_ack_required`) instead of just
 *  the bare status code. */
function apiErrorDetail(res: ApiResult): string {
  const parts = [`http_${res.status}`]
  const err = res.json?.error
  if (typeof err === 'string' && err) parts.push(err)
  const msg = res.json?.message
  if (typeof msg === 'string' && msg && msg !== err) parts.push(msg)
  return parts.join(' ')
}

/** Health precheck (spec resolution): before anything else, confirm the
 *  daemon behind `internal-api-info.json` is actually alive by hitting
 *  `GET /v1/health` with the FILE token (never the operator token — this
 *  probe deliberately uses the narrowest credential). A stale info file
 *  left behind by a crash loop otherwise looks identical to "daemon is
 *  fine but this one call failed", which used to surface as a confusing
 *  exit 1 (`http_0 ...`) instead of the honest "daemon isn't running"
 *  (exit 2). */
async function healthPrecheck(deps: SelftestDeps, api: { baseUrl: string; token: string }): Promise<void> {
  try {
    const res = await deps.fetch(`${api.baseUrl}/v1/health`, {
      headers: { authorization: `Bearer ${api.token}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error('daemon_not_running')
  } catch (err) {
    if (err instanceof Error && err.message === 'daemon_not_running') throw err
    throw new Error('daemon_not_running')
  }
}

// ── workbench ───────────────────────────────────────────────────────

interface WorkbenchEventLite { id: number | string; kind: string; text: string; activity?: unknown }
interface WorkbenchPermissionLite { id: string; tool: string; description: string }
interface WorkbenchTaskLite { id?: string; status?: string; phase?: string; error?: string | null }

interface PollResult {
  events: WorkbenchEventLite[]
  finalTask: WorkbenchTaskLite
  timedOut: boolean
  allowedAny: boolean
  /** Set when at least one permission POST came back non-2xx — surfaced in
   *  the `permission_roundtrip` check's detail instead of silently
   *  swallowed (review fix). */
  permissionFailureDetail?: string
  lastVersion: number
}

/** Long-polls `GET /v1/workbench/task`, auto-allowing every pending
 *  permission card, until the task reaches a terminal `status` OR
 *  `phase==='replied'` (retained-session executors like claude/codex can
 *  sit at `status:'running', phase:'replied'` for a while after answering
 *  — that's still "done talking" for our purposes, see the finalize step
 *  in `runWorkbenchSelftest` for what happens to the still-live session
 *  afterwards) — or until `deadline`. */
async function pollWorkbenchTask(deps: SelftestDeps, api: ApiCtx, taskId: string, sinceVersion: number, deadline: number): Promise<PollResult> {
  let since = sinceVersion
  const events: WorkbenchEventLite[] = []
  const seenEventIds = new Set<string | number>()
  let allowedAny = false
  let permissionFailureDetail: string | undefined
  const answered = new Set<string>()
  for (;;) {
    if (deps.now() >= deadline) return { events, finalTask: {}, timedOut: true, allowedAny, permissionFailureDetail, lastVersion: since }
    const before = deps.now()
    const res = await apiCall(deps, api, 'GET', `/v1/workbench/task?id=${taskId}&since=${since}&wait_ms=20000`)
    if (!res.ok || !res.json) {
      return { events, finalTask: { status: 'failed', phase: 'failed', error: apiErrorDetail(res) }, timedOut: false, allowedAny, permissionFailureDetail, lastVersion: since }
    }
    const detail = res.json as { task?: WorkbenchTaskLite; events?: WorkbenchEventLite[]; permissions?: WorkbenchPermissionLite[]; version?: number }
    // Rows can repeat across polls when `since` hasn't advanced (e.g. a
    // wait that timed out with nothing new) — dedupe by id.
    for (const e of detail.events ?? []) {
      if (seenEventIds.has(e.id)) continue
      seenEventIds.add(e.id)
      events.push(e)
    }
    if (typeof detail.version === 'number') since = detail.version
    for (const perm of detail.permissions ?? []) {
      if (answered.has(perm.id)) continue
      answered.add(perm.id)
      const permRes = await apiCall(deps, api, 'POST', '/v1/workbench/permission', { id: taskId, requestId: perm.id, decision: 'allow' })
      if (permRes.ok) allowedAny = true
      else permissionFailureDetail = apiErrorDetail(permRes)
    }
    const status = detail.task?.status
    const phase = detail.task?.phase
    const terminal = (!!status && TERMINAL_STATUSES.has(status)) || phase === 'replied'
    if (terminal) return { events, finalTask: detail.task ?? {}, timedOut: false, allowedAny, permissionFailureDetail, lastVersion: since }
    if (deps.now() >= deadline) return { events, finalTask: detail.task ?? {}, timedOut: true, allowedAny, permissionFailureDetail, lastVersion: since }
    if (deps.now() - before < POLL_MIN_INTERVAL_MS) await deps.sleep(POLL_IDLE_SLEEP_MS)
  }
}

/** Narrower poll used only after we've asked a still-running task to
 *  cancel: waits for `task.status` itself to reach a terminal value
 *  (ignores `phase` — it's already `'replied'`, that's *why* we're here). */
async function waitForTerminalStatus(deps: SelftestDeps, api: ApiCtx, taskId: string, sinceVersion: number, deadline: number): Promise<{ status?: string; timedOut: boolean }> {
  let since = sinceVersion
  for (;;) {
    if (deps.now() >= deadline) return { timedOut: true }
    const before = deps.now()
    const res = await apiCall(deps, api, 'GET', `/v1/workbench/task?id=${taskId}&since=${since}&wait_ms=20000`)
    if (!res.ok || !res.json) return { timedOut: false }
    const detail = res.json as { task?: WorkbenchTaskLite; permissions?: WorkbenchPermissionLite[]; version?: number }
    if (typeof detail.version === 'number') since = detail.version
    for (const perm of detail.permissions ?? []) {
      await apiCall(deps, api, 'POST', '/v1/workbench/permission', { id: taskId, requestId: perm.id, decision: 'allow' })
    }
    const status = detail.task?.status
    if (status && TERMINAL_STATUSES.has(status)) return { status, timedOut: false }
    if (deps.now() >= deadline) return { status, timedOut: true }
    if (deps.now() - before < POLL_MIN_INTERVAL_MS) await deps.sleep(POLL_IDLE_SLEEP_MS)
  }
}

/** git is a nicety (a maintainer poking around the scratch project gets a
 *  real repo to diff against), not a signal the run's PASS/FAIL should
 *  depend on — its absence or failure is logged as a warning, not a check
 *  (review fix: the checks list should be exactly the spec's). */
function gitInit(deps: SelftestDeps, scratchPath: string): void {
  if (!deps.git) { deps.log('selftest: git_init skipped (no git in deps)'); return }
  try {
    if (!deps.git(['init'], scratchPath)) { deps.log('selftest: git_init skipped (git init failed)'); return }
    deps.git(['add', '-A'], scratchPath)
    const committed = deps.git(['-c', 'user.email=selftest@wechat-cc.local', '-c', 'user.name=wechat-cc selftest', 'commit', '-m', 'selftest init'], scratchPath)
    deps.log(`selftest: git_init ${committed ? 'committed' : 'init only (commit failed)'}`)
  } catch (err) {
    deps.log(`selftest: git_init skipped (${err instanceof Error ? err.message : String(err)})`)
  }
}

function cleanupScratch(deps: SelftestDeps, scratchPath: string, keep: boolean | undefined): void {
  if (keep) return
  try { deps.fs.rm(scratchPath) } catch { /* best-effort */ }
}

export async function runWorkbenchSelftest(
  deps: SelftestDeps,
  opts: { executor: string; image?: boolean; resume?: boolean; timeoutMs?: number; keep?: boolean },
): Promise<SelftestReport> {
  const start = deps.now()
  const api = deps.readApiInfo()
  if (!api) throw new Error('daemon_not_running')
  await healthPrecheck(deps, api)

  const checks: SelftestCheck[] = []
  const scratchPath = `${deps.stateDir}/selftest/wb-${deps.now()}`
  deps.fs.mkdir(scratchPath)
  deps.fs.write(`${scratchPath}/README.md`, 'wechat-cc selftest workbench scratch project\n')
  gitInit(deps, scratchPath)

  let draftId: string | undefined
  let attachmentIds: string[] | undefined
  if (opts.image) {
    const png = redSquarePng()
    const id = randomUUID()
    const candidateDraftId = randomUUID()
    const uploadRes = await apiCall(deps, api, 'POST', '/v1/workbench/attachment', {
      id, draftId: candidateDraftId, name: 'square.png', mime: 'image/png', base64: Buffer.from(png).toString('base64'),
    })
    if (uploadRes.ok) {
      draftId = candidateDraftId
      attachmentIds = [id]
    } else {
      deps.log(`selftest: image attachment upload failed: ${apiErrorDetail(uploadRes)}`)
    }
  }

  const text = opts.image ? DEFAULT_IMAGE_TEXT : DEFAULT_CREATE_TEXT
  const createRes = await apiCall(deps, api, 'POST', '/v1/workbench/create', {
    path: scratchPath,
    providerId: opts.executor,
    title: 'selftest',
    text,
    ...(draftId ? { draftId } : {}),
    ...(attachmentIds ? { attachmentIds } : {}),
  })
  const taskId = createRes.ok && createRes.json?.task?.id ? String(createRes.json.task.id) : undefined
  checks.push({ name: 'created', ok: !!taskId, detail: taskId ?? apiErrorDetail(createRes) })

  const report: SelftestReport = { ok: false, kind: 'workbench', target: opts.executor, checks, scratchPath, durationMs: 0 }

  if (!taskId) {
    checks.push({ name: 'replied', ok: false, detail: 'not created' })
    report.ok = checks.every((c) => c.ok)
    report.durationMs = deps.now() - start
    cleanupScratch(deps, scratchPath, opts.keep)
    return report
  }
  report.taskId = taskId

  const timeoutMs = opts.timeoutMs ?? DEFAULT_WORKBENCH_TIMEOUT_MS
  const deadline = start + timeoutMs

  const phase1 = await pollWorkbenchTask(deps, api, taskId, 0, deadline)
  const repliedOk = !phase1.timedOut && ((!!phase1.finalTask.status && phase1.finalTask.status === 'completed') || phase1.finalTask.phase === 'replied')
  checks.push({ name: 'replied', ok: repliedOk, detail: phase1.timedOut ? 'timeout' : (phase1.finalTask.status ?? phase1.finalTask.phase ?? 'unknown') })

  const textEvents1 = phase1.events.filter((e) => e.kind === 'text')
  checks.push({ name: 'text_seen', ok: textEvents1.length > 0, detail: `${textEvents1.length} text event(s)` })

  if (!opts.image) {
    const activityEvents = phase1.events.filter((e) => e.kind === 'tool_call' && e.activity)
    checks.push({ name: 'activity_seen', ok: activityEvents.length > 0, detail: `${activityEvents.length} activity event(s)` })
    checks.push({ name: 'permission_roundtrip', ok: phase1.allowedAny, detail: phase1.allowedAny ? 'allowed' : (phase1.permissionFailureDetail ?? 'no permission card seen') })
    const helloContent = deps.fs.read(`${scratchPath}/hello.txt`)
    checks.push({ name: 'file_written', ok: helloContent !== null && helloContent.trim() === 'hello', detail: helloContent === null ? 'hello.txt missing' : helloContent.trim() })
  } else {
    const mentionsRed = textEvents1.some((e) => e.text.includes('红'))
    checks.push({ name: 'answer_mentions_red', ok: mentionsRed, detail: mentionsRed ? 'mentions 红' : 'no mention of 红' })
  }

  let allEvents = phase1.events
  let latestStatus = phase1.finalTask.status
  let latestVersion = phase1.lastVersion

  if (opts.resume) {
    const continueRes = await apiCall(deps, api, 'POST', '/v1/workbench/continue', { id: taskId, text: RESUME_WORKBENCH_TEXT })
    if (!continueRes.ok) {
      checks.push({ name: 'resume_replied', ok: false, detail: apiErrorDetail(continueRes) })
    } else {
      const phase2 = await pollWorkbenchTask(deps, api, taskId, latestVersion, deadline)
      const resumeTextSeen = phase2.events.some((e) => e.kind === 'text')
      checks.push({ name: 'resume_replied', ok: resumeTextSeen && !phase2.timedOut, detail: phase2.timedOut ? 'timeout' : `${phase2.events.length} event(s)` })
      allEvents = allEvents.concat(phase2.events)
      latestStatus = phase2.finalTask.status
      latestVersion = phase2.lastVersion
    }
  }

  const errorEvents = allEvents.filter((e) => e.kind === 'error')
  checks.push({ name: 'no_error_event', ok: errorEvents.length === 0, detail: errorEvents.length ? errorEvents[0]!.text : undefined })

  // Finalize: a retained-session executor (claude/codex) can still be
  // sitting on a live subprocess even though it already "replied" (that's
  // what `phase==='replied'` with `status:'running'` means) — archiving or
  // deleting the scratch dir out from under it 409s (workbench_busy,
  // swallowed) and can corrupt a live session's working tree. So: if the
  // last status we actually saw isn't terminal, ask it to cancel and wait
  // briefly (capped, never past the overall deadline) before archiving.
  if (latestStatus && !TERMINAL_STATUSES.has(latestStatus)) {
    await apiCall(deps, api, 'POST', '/v1/workbench/cancel', { id: taskId })
    const cancelDeadline = Math.min(deadline, deps.now() + CANCEL_WAIT_MS)
    await waitForTerminalStatus(deps, api, taskId, latestVersion, cancelDeadline)
  }

  const archiveRes = await apiCall(deps, api, 'POST', '/v1/workbench/archive', { id: taskId, archived: true })
  checks.push({ name: 'archived', ok: archiveRes.ok, detail: archiveRes.ok ? undefined : apiErrorDetail(archiveRes) })
  cleanupScratch(deps, scratchPath, opts.keep)

  report.ok = checks.every((c) => c.ok)
  report.durationMs = deps.now() - start
  return report
}

// ── chat ────────────────────────────────────────────────────────────

interface SelftestConverseResultLite {
  ok: boolean
  sessionId: string | null
  texts: string[]
  toolCalls: string[]
  error?: string
}

/** Detail string for a converse check: prefer the HTTP-level error (route
 *  itself rejected the request) over the turn-level one (route accepted it
 *  but the conversation failed), and fall back to a short summary. */
function converseDetail(res: ApiResult, r: SelftestConverseResultLite | undefined): string {
  if (!res.ok) return apiErrorDetail(res)
  if (r?.error) return r.error
  return `${r?.texts.length ?? 0} text(s)`
}

export async function runChatSelftest(
  deps: SelftestDeps,
  opts: { provider: string; text?: string; resume?: boolean; timeoutMs?: number },
): Promise<SelftestReport> {
  const start = deps.now()
  const api = deps.readApiInfo()
  if (!api) throw new Error('daemon_not_running')
  await healthPrecheck(deps, api)

  const checks: SelftestCheck[] = []
  const usingDefaultText = opts.text === undefined
  const text = opts.text ?? DEFAULT_CHAT_TEXT

  const res1 = await apiCall(deps, api, 'POST', '/v1/selftest/converse', { providerId: opts.provider, text })
  const r1: SelftestConverseResultLite | undefined = res1.ok ? res1.json : undefined

  checks.push({ name: 'replied', ok: !!r1?.ok && (r1?.texts.length ?? 0) > 0, detail: converseDetail(res1, r1) })
  if (usingDefaultText) {
    checks.push({ name: 'tool_seen', ok: !!r1?.toolCalls.includes('wechat/ping'), detail: r1 ? (r1.toolCalls.join(',') || '(none)') : apiErrorDetail(res1) })
  }
  checks.push({ name: 'no_error', ok: !!r1 && !r1.error, detail: r1 ? r1.error : apiErrorDetail(res1) })

  const report: SelftestReport = { ok: false, kind: 'chat', target: opts.provider, checks, durationMs: 0 }
  if (r1?.sessionId) report.sessionId = r1.sessionId

  if (opts.resume) {
    if (!r1?.sessionId) {
      // Sending resumeSessionId:'' is worse than not resuming at all — the
      // daemon just drops the empty string and runs turn 2 fresh, which
      // would make this check pass for the wrong reason.
      checks.push({ name: 'resume_replied', ok: false, detail: 'no session id from first turn' })
    } else {
      const res2 = await apiCall(deps, api, 'POST', '/v1/selftest/converse', {
        providerId: opts.provider,
        text: RESUME_CHAT_TEXT,
        resumeSessionId: r1.sessionId,
      })
      const r2: SelftestConverseResultLite | undefined = res2.ok ? res2.json : undefined
      checks.push({ name: 'resume_replied', ok: !!r2?.ok && (r2?.texts.length ?? 0) > 0, detail: converseDetail(res2, r2) })
      if (r2?.sessionId) report.sessionId = r2.sessionId
    }
  }

  report.ok = checks.every((c) => c.ok)
  report.durationMs = deps.now() - start
  return report
}

// ── human/JSON output ───────────────────────────────────────────────

export function formatSelftestReport(r: SelftestReport): string {
  const lines = r.checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`)
  lines.push(r.ok ? 'PASS' : 'FAIL')
  return lines.join('\n')
}

// ── real deps (used by cli.ts) ──────────────────────────────────────

export function defaultSelftestDeps(stateDir: string): SelftestDeps {
  return {
    fetch,
    readApiInfo: () => readApiInfoReal(stateDir),
    stateDir,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    fs: {
      mkdir: (p) => mkdirSync(p, { recursive: true }),
      write: (p, text) => writeFileSync(p, text),
      read: (p) => { try { return readFileSync(p, 'utf8') } catch { return null } },
      rm: (p) => { try { rmSync(p, { recursive: true, force: true }) } catch { /* best-effort */ } },
    },
    git: (args, cwd) => {
      try { return spawnSync('git', args, { cwd, stdio: 'ignore' }).status === 0 } catch { return false }
    },
    log: (line) => console.error(`[selftest] ${line}`),
  }
}

function readApiInfoReal(stateDir: string): { baseUrl: string; token: string; operatorToken: string } | null {
  try {
    const infoPath = join(stateDir, 'internal-api-info.json')
    const info = readJsonFile<{ baseUrl?: string; tokenFilePath?: string; operatorTokenFilePath?: string }>(infoPath)
    if (!info.baseUrl || !info.tokenFilePath || !info.operatorTokenFilePath) return null
    return {
      baseUrl: info.baseUrl,
      token: readFileSync(info.tokenFilePath, 'utf8').trim(),
      operatorToken: readFileSync(info.operatorTokenFilePath, 'utf8').trim(),
    }
  } catch {
    return null
  }
}
