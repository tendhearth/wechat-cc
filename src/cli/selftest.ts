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
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    let json: any = null
    try { json = await res.json() } catch { /* body optional */ }
    return { ok: res.ok, status: res.status, json }
  } catch (err) {
    return { ok: false, status: 0, json: { error: err instanceof Error ? err.message : String(err) } }
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
  lastVersion: number
}

async function pollWorkbenchTask(deps: SelftestDeps, api: ApiCtx, taskId: string, sinceVersion: number, deadline: number): Promise<PollResult> {
  let since = sinceVersion
  const events: WorkbenchEventLite[] = []
  let allowedAny = false
  const answered = new Set<string>()
  for (;;) {
    const res = await apiCall(deps, api, 'GET', `/v1/workbench/task?id=${taskId}&since=${since}&wait_ms=20000`)
    if (!res.ok || !res.json) {
      return { events, finalTask: { status: 'failed', phase: 'failed', error: `http_${res.status}` }, timedOut: false, allowedAny, lastVersion: since }
    }
    const detail = res.json as { task?: WorkbenchTaskLite; events?: WorkbenchEventLite[]; permissions?: WorkbenchPermissionLite[]; version?: number }
    events.push(...(detail.events ?? []))
    if (typeof detail.version === 'number') since = detail.version
    for (const perm of detail.permissions ?? []) {
      if (answered.has(perm.id)) continue
      answered.add(perm.id)
      await apiCall(deps, api, 'POST', '/v1/workbench/permission', { id: taskId, requestId: perm.id, decision: 'allow' })
      allowedAny = true
    }
    const status = detail.task?.status
    const phase = detail.task?.phase
    const terminal = (!!status && TERMINAL_STATUSES.has(status)) || phase === 'replied'
    if (terminal) return { events, finalTask: detail.task ?? {}, timedOut: false, allowedAny, lastVersion: since }
    if (deps.now() >= deadline) return { events, finalTask: detail.task ?? {}, timedOut: true, allowedAny, lastVersion: since }
  }
}

function gitInitCheck(deps: SelftestDeps, scratchPath: string): SelftestCheck {
  // git is a nicety (a maintainer poking around the scratch project gets a
  // real repo to diff against) — its absence or failure is a warning, never
  // a reason to fail the whole selftest run.
  if (!deps.git) return { name: 'git_init', ok: true, detail: 'skipped' }
  try {
    if (!deps.git(['init'], scratchPath)) return { name: 'git_init', ok: true, detail: 'skipped' }
    deps.git(['add', '-A'], scratchPath)
    const committed = deps.git(['-c', 'user.email=selftest@wechat-cc.local', '-c', 'user.name=wechat-cc selftest', 'commit', '-m', 'selftest init'], scratchPath)
    return { name: 'git_init', ok: true, detail: committed ? 'committed' : 'init only' }
  } catch {
    return { name: 'git_init', ok: true, detail: 'skipped' }
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

  const checks: SelftestCheck[] = []
  const scratchPath = `${deps.stateDir}/selftest/wb-${deps.now()}`
  deps.fs.mkdir(scratchPath)
  deps.fs.write(`${scratchPath}/README.md`, 'wechat-cc selftest workbench scratch project\n')
  checks.push(gitInitCheck(deps, scratchPath))

  let draftId: string | undefined
  let attachmentIds: string[] | undefined
  if (opts.image) {
    const png = redSquarePng()
    const id = randomUUID()
    draftId = randomUUID()
    await apiCall(deps, api, 'POST', '/v1/workbench/attachment', {
      id, draftId, name: 'square.png', mime: 'image/png', base64: Buffer.from(png).toString('base64'),
    })
    attachmentIds = [id]
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
  checks.push({ name: 'created', ok: !!taskId, detail: taskId ?? `http_${createRes.status}` })

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
    checks.push({ name: 'permission_roundtrip', ok: phase1.allowedAny, detail: phase1.allowedAny ? 'allowed' : 'no permission card seen' })
    const helloContent = deps.fs.read(`${scratchPath}/hello.txt`)
    checks.push({ name: 'file_written', ok: helloContent !== null && helloContent.trim() === 'hello', detail: helloContent === null ? 'hello.txt missing' : helloContent.trim() })
  } else {
    const mentionsRed = textEvents1.some((e) => e.text.includes('红'))
    checks.push({ name: 'answer_mentions_red', ok: mentionsRed, detail: mentionsRed ? 'mentions 红' : 'no mention of 红' })
  }

  let allEvents = phase1.events
  if (opts.resume) {
    await apiCall(deps, api, 'POST', '/v1/workbench/continue', { id: taskId, text: RESUME_WORKBENCH_TEXT })
    const phase2 = await pollWorkbenchTask(deps, api, taskId, phase1.lastVersion, deadline)
    const resumeTextSeen = phase2.events.some((e) => e.kind === 'text')
    checks.push({ name: 'resume_replied', ok: resumeTextSeen && !phase2.timedOut, detail: phase2.timedOut ? 'timeout' : `${phase2.events.length} event(s)` })
    allEvents = allEvents.concat(phase2.events)
  }

  const errorEvents = allEvents.filter((e) => e.kind === 'error')
  checks.push({ name: 'no_error_event', ok: errorEvents.length === 0, detail: errorEvents.length ? errorEvents[0]!.text : undefined })

  await apiCall(deps, api, 'POST', '/v1/workbench/archive', { id: taskId, archived: true })
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

export async function runChatSelftest(
  deps: SelftestDeps,
  opts: { provider: string; text?: string; resume?: boolean; timeoutMs?: number },
): Promise<SelftestReport> {
  const start = deps.now()
  const api = deps.readApiInfo()
  if (!api) throw new Error('daemon_not_running')

  const checks: SelftestCheck[] = []
  const usingDefaultText = opts.text === undefined
  const text = opts.text ?? DEFAULT_CHAT_TEXT

  const res1 = await apiCall(deps, api, 'POST', '/v1/selftest/converse', { providerId: opts.provider, text })
  const r1: SelftestConverseResultLite | undefined = res1.ok ? res1.json : undefined

  checks.push({ name: 'replied', ok: !!r1?.ok && (r1?.texts.length ?? 0) > 0, detail: r1 ? (r1.error ?? `${r1.texts.length} text(s)`) : `http_${res1.status}` })
  if (usingDefaultText) {
    checks.push({ name: 'tool_seen', ok: !!r1?.toolCalls.includes('wechat/ping'), detail: r1 ? r1.toolCalls.join(',') || '(none)' : 'no result' })
  }
  checks.push({ name: 'no_error', ok: !r1?.error, detail: r1?.error })

  const report: SelftestReport = { ok: false, kind: 'chat', target: opts.provider, checks, durationMs: 0 }
  if (r1?.sessionId) report.sessionId = r1.sessionId

  if (opts.resume) {
    const res2 = await apiCall(deps, api, 'POST', '/v1/selftest/converse', {
      providerId: opts.provider,
      text: RESUME_CHAT_TEXT,
      resumeSessionId: r1?.sessionId ?? '',
    })
    const r2: SelftestConverseResultLite | undefined = res2.ok ? res2.json : undefined
    checks.push({ name: 'resume_replied', ok: !!r2?.ok && (r2?.texts.length ?? 0) > 0, detail: r2 ? (r2.error ?? `${r2.texts.length} text(s)`) : `http_${res2.status}` })
    if (r2?.sessionId) report.sessionId = r2.sessionId
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
