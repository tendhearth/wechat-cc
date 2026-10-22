/**
 * hook.ts — `wechat-cc hook …`:终端 claude / codex / cursor 会话的 hooks 出口
 * (spec docs/superpowers/specs/2026-09-09-cli-hook-push-design.md)。
 *
 * 三块纯逻辑,cli.ts 只做拼装:
 *   1. normalizeHookPayload:两家的 hook JSON → daemon 认的 CliEvent(不认的事件回 null)
 *   2. postCliEvent:读 internal-api-info.json,POST /v1/cli/event;任何失败都只是 ok:false
 *   3. installHooks / uninstallHooks / hookStatus:幂等写 ~/.claude/settings.json、
 *      $CODEX_HOME/hooks.json 与 ~/.cursor/hooks.json;只动带自己标记的条目,别人的 hook 原样保留
 *
 * Cursor(2026-10-15):~/.cursor/hooks.json 是另一种形状(`{version:1,hooks:{<event>:[{command,timeout}]}}`,
 * 没有 type / statusMessage),事件名也不同(stop / beforeSubmitPrompt / sessionEnd /
 * beforeShellExecution / beforeMCPExecution);会话 id 是 conversation_id,目录是 workspace_roots[0]。
 * IDE 里的 agent 和终端 cursor-agent 都会触发,所以「Cursor」= 两者。Cursor 的 hook 一律同步等输出,
 * 权限类的答复是 `{"permission":"allow"|"deny"|"ask"}` —— 没拿到主人的决定一律 ask(让 Cursor 自己问,
 * 绝不替主人放行)。
 *
 * 回环守卫:daemon 自己经 SDK 拉起的 claude / codex 继承 daemon 的环境,daemon 启动时
 * 置 WECHAT_CC_DAEMON_CHILD=1(daemon/main.ts);hook 看到就直接退出,不然 daemon 的每个
 * 回合都会被推回微信。
 */
import { writeFileAtomic } from '../lib/json-file'
import { toolInputFacts } from '../core/permission-rules/facts'
import { existsSync, readFileSync, mkdirSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { hostname } from 'node:os'
import { readJsonFile } from '../lib/read-json-file'
import { machineIdleSeconds } from '../lib/machine-idle'
import type { CliEvent, CliSource } from '../core/cli-events'
import { lastAssistantText } from '../core/cli-transcript'
import type { CliPermissionRequest, CliPermissionStatus } from '../core/cli-permission-relay'

export type HookSource = CliSource

export const DAEMON_CHILD_ENV = 'WECHAT_CC_DAEMON_CHILD'
/** 写进 hook 条目的 statusMessage,和 `hook <source>` 的命令尾巴一起当自家标记。 */
export const HOOK_STATUS_MESSAGE = 'wechat-cc → 微信'
const HOOK_TIMEOUT_SEC = 5
const TOOL_SUMMARY_MAX = 200

export function shouldSkipHook(env: Record<string, string | undefined>): boolean {
  return env[DAEMON_CHILD_ENV] === '1'
}

// ── 1. payload 归一化 ─────────────────────────────────────────────────────────

type Raw = Record<string, unknown>

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/**
 * harness 自己塞进会话的 prompt:/loop 唤醒(ScheduleWakeup 原样回灌 `/loop …`,或展开成
 * `<command-message>loop</command-message>`)、后台任务 / 监视器通知、system-reminder。
 * 它们会触发 UserPromptSubmit,但主人并没有回到键盘前 —— 2026-09-09 真机上一个自跑的
 * 循环每个 tick 都推了一条,就是因为把它们当成了主人的 prompt。
 */
export function isAutomatedPrompt(prompt: string): boolean {
  const p = prompt.trimStart()
  return /^\/loop\b/.test(p)
    || p.startsWith('<task-notification>')
    || p.startsWith('<system-reminder>')
    || /^<command-message>loop<\/command-message>/.test(p)
}

/** 工具参数摘要:有 command 就用 command(数组拼空格),否则 JSON 截断。 */
export function summarizeToolInput(input: unknown): string {
  if (input === null || input === undefined) return ''
  if (typeof input === 'object') {
    const cmd = (input as Raw)['command']
    if (typeof cmd === 'string') return cmd
    if (Array.isArray(cmd)) return cmd.map(String).join(' ')
  }
  let s: string
  try { s = typeof input === 'string' ? input : JSON.stringify(input) } catch { s = String(input) }
  return s.length > TOOL_SUMMARY_MAX ? s.slice(0, TOOL_SUMMARY_MAX - 1) + '…' : s
}

/**
 * 两家的 hook JSON → CliEvent。不认的事件 / 子代理 / 缺关键字段 → null(hook 静默退出)。
 * Claude 与 Codex 的 Stop 都带 last_assistant_message(Claude 文档明说别读 transcript,
 * 它会滞后);Claude 的权限走 Notification(permission_prompt),Codex 走 PermissionRequest。
 */
export function normalizeHookPayload(source: HookSource, raw: unknown): CliEvent | null {
  if (!raw || typeof raw !== 'object') return null
  if (source === 'cursor') return normalizeCursorPayload(raw as Raw)
  const r = raw as Raw
  if (str(r['agent_id'])) return null   // 子代理:主会话的 Stop 才是主人关心的
  const session_id = str(r['session_id'])
  const cwd = str(r['cwd'])
  const event = str(r['hook_event_name'])
  if (!session_id || !cwd || !event) return null
  const transcript = str(r['transcript_path'])
  const base: Omit<CliEvent, 'kind'> = transcript ? { source, session_id, cwd, transcript_path: transcript } : { source, session_id, cwd }
  const withText = (kind: CliEvent['kind'], text: string | undefined): CliEvent =>
    text ? { ...base, kind, text } : { ...base, kind }

  switch (event) {
    case 'Stop':
      return withText('stop', str(r['last_assistant_message']))
    case 'UserPromptSubmit':
      return isAutomatedPrompt(str(r['prompt']) ?? '') ? { ...base, kind: 'prompt', automated: true } : { ...base, kind: 'prompt' }
    case 'SessionEnd':
      return { ...base, kind: 'session_end' }
    // PermissionRequest 不是「事件」,是要答复的问题 —— 走 parsePermissionRequest。
    default:
      return null
  }
}

/**
 * 两家的 PermissionRequest hook JSON(形状相同:tool_name / tool_input)→ 中继请求。
 * 只有 hook 直接调的那一路会用;不是 PermissionRequest / 子代理 / 缺字段 → null。
 */
export function parsePermissionRequest(source: HookSource, raw: unknown): CliPermissionRequest | null {
  if (!raw || typeof raw !== 'object') return null
  if (source === 'cursor') return parseCursorPermission(raw as Raw)
  const r = raw as Raw
  if (r['hook_event_name'] !== 'PermissionRequest') return null
  if (str(r['agent_id'])) return null
  const session_id = str(r['session_id'])
  const cwd = str(r['cwd'])
  const tool_name = str(r['tool_name'])
  if (!session_id || !cwd || !tool_name) return null
  const summary = summarizeToolInput(r['tool_input'])
  const req: CliPermissionRequest = summary ? { source, session_id, cwd, tool_name, summary } : { source, session_id, cwd, tool_name }
  // 放行规则(2026-10-19)要原文:命令不压缩(截 2000),文件路径单列。拿不到就不给,daemon 那头不猜。
  const facts = toolInputFacts(r['tool_input'])
  if (facts.command) req.command = facts.command
  if (facts.paths.length) req.paths = facts.paths
  return req
}


// ── 1b. Cursor ────────────────────────────────────────────────────────────────

/** Cursor 的会话 id 与目录:conversation_id(没有再看 session_id)、workspace_roots[0](没有再看 cwd)。 */
function cursorIdent(r: Raw): Omit<CliEvent, 'kind'> | null {
  const session_id = str(r['conversation_id']) ?? str(r['session_id'])
  const roots = Array.isArray(r['workspace_roots']) ? r['workspace_roots'] : []
  const cwd = str(roots[0]) ?? str(r['cwd'])
  if (!session_id || !cwd) return null
  const transcript = str(r['transcript_path'])
  return transcript ? { source: 'cursor', session_id, cwd, transcript_path: transcript } : { source: 'cursor', session_id, cwd }
}

/**
 * Cursor 的 hook JSON → CliEvent。stop 不带最后一句(Cursor 没有 last_assistant_message),
 * 由 withCursorStopText 从 transcript 尾巴补;不认的事件 → null。
 */
export function normalizeCursorPayload(r: Raw): CliEvent | null {
  const base = cursorIdent(r)
  if (!base) return null
  switch (str(r['hook_event_name'])) {
    case 'stop':
      return { ...base, kind: 'stop' }
    case 'beforeSubmitPrompt':
      return isAutomatedPrompt(str(r['prompt']) ?? '') ? { ...base, kind: 'prompt', automated: true } : { ...base, kind: 'prompt' }
    case 'sessionEnd':
      return { ...base, kind: 'session_end' }
    default:
      return null
  }
}

/** beforeShellExecution / beforeMCPExecution → 中继请求;Shell 的摘要就是命令本身,MCP 的工具名带上 server。 */
export function parseCursorPermission(r: Raw): CliPermissionRequest | null {
  const event = str(r['hook_event_name'])
  if (event !== 'beforeShellExecution' && event !== 'beforeMCPExecution') return null
  const base = cursorIdent(r)
  if (!base) return null
  const { session_id, cwd } = base
  if (event === 'beforeShellExecution') {
    const command = str(r['command'])
    if (!command) return null
    return { source: 'cursor', session_id, cwd, tool_name: 'Shell', summary: summarizeToolInput(command) }
  }
  const tool = str(r['tool_name'])
  if (!tool) return null
  const server = str(r['mcp_server_name'])
  let input: unknown = r['tool_input']
  if (typeof input === 'string') { try { input = JSON.parse(input) } catch { /* 原样当文字 */ } }
  const summary = summarizeToolInput(input)
  const tool_name = server ? `${server}:${tool}` : tool
  return summary ? { source: 'cursor', session_id, cwd, tool_name, summary } : { source: 'cursor', session_id, cwd, tool_name }
}

const CURSOR_TRANSCRIPT_READ_MAX = 256 * 1024

function readTranscriptTail(path: string, max = CURSOR_TRANSCRIPT_READ_MAX): string {
  const size = statSync(path).size
  if (size <= max) return readFileSync(path, 'utf8')
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(max)
    readSync(fd, buf, 0, max, size - max)
    const s = buf.toString('utf8')
    return s.slice(s.indexOf('\n') + 1)
  } finally { closeSync(fd) }
}

/**
 * Cursor 的 stop:从 transcript 尾巴读最后一句助手的话补进 text。读不到 / 最后一行不是助手 ⇒ 原样
 * (daemon 那头没有最后一句也照样推「完成了」)。只对 cursor 的 stop 动手。永远不抛。
 */
export function withCursorStopText(ev: CliEvent, readFile: (p: string) => string = readTranscriptTail): CliEvent {
  if (ev.source !== 'cursor' || ev.kind !== 'stop' || ev.text || !ev.transcript_path) return ev
  try {
    const text = lastAssistantText(readFile(ev.transcript_path), 'cursor')
    return text ? { ...ev, text } : ev
  } catch { return ev }
}

/**
 * Cursor 权限类 hook 的 stdout。拿到主人的 allow / deny 就照答;其他(主人在场、没答、超时、
 * daemon 没跑……)一律 ask:让 Cursor 在本机问,绝不替主人放行。
 */
export function cursorPermissionOutput(decision: 'allow' | 'deny' | null): string {
  if (decision === 'allow') return JSON.stringify({ permission: 'allow' })
  if (decision === 'deny') return JSON.stringify({ permission: 'deny', user_message: '主人在微信里拒绝了这次操作', agent_message: 'The owner denied this action remotely (via WeChat). Do not retry it; ask the owner how to proceed.' })
  return JSON.stringify({ permission: 'ask' })
}

/** Cursor 非权限类 hook 的 stdout:beforeSubmitPrompt 要明说放行;其余给个空对象。 */
export function cursorEventOutput(raw: unknown): string {
  const event = raw && typeof raw === 'object' ? (raw as Raw)['hook_event_name'] : undefined
  return event === 'beforeSubmitPrompt' ? JSON.stringify({ continue: true }) : '{}'
}

/**
 * 给事件 / 权限请求补上「这台机是谁、有没有人在用」:主机名 + 本机空闲秒数。
 * 空闲探不到就不带(daemon 那头回落到别的信号)。
 */
export async function withMachineContext<T extends object>(payload: T, probe: () => Promise<number | null> = () => machineIdleSeconds()): Promise<T & { machine: string; idle_s?: number }> {
  let idle: number | null = null
  try { idle = await probe() } catch { idle = null }
  return idle === null ? { ...payload, machine: hostname() } : { ...payload, machine: hostname(), idle_s: Math.round(idle) }
}

// ── 2. POST 给 daemon ─────────────────────────────────────────────────────────

export interface PostCliEventOpts {
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export type PostCliEventResult =
  | { ok: true; action?: string }
  | { ok: false; reason: string }

/** 读 `<stateDir>/internal-api-info.json`(与 `wechat-cc agent` 同源)拿 baseUrl + FILE token。 */
function readApiInfo(stateDir: string): { baseUrl: string; token: string } | { reason: string } {
  const infoPath = join(stateDir, 'internal-api-info.json')
  if (!existsSync(infoPath)) return { reason: 'daemon_not_running' }
  let info: { baseUrl?: string; tokenFilePath?: string }
  try { info = readJsonFile(infoPath) } catch { return { reason: 'info_malformed' } }
  if (!info.baseUrl || !info.tokenFilePath) return { reason: 'info_incomplete' }
  try { return { baseUrl: info.baseUrl, token: readFileSync(info.tokenFilePath, 'utf8').trim() } }
  catch { return { reason: 'token_unreadable' } }
}

/**
 * POST /v1/cli/event。永远不抛:daemon 没跑、超时、非 2xx 都只是 ok:false。
 */
export async function postCliEvent(stateDir: string, ev: CliEvent, opts: PostCliEventOpts = {}): Promise<PostCliEventResult> {
  const api = readApiInfo(stateDir)
  if ('reason' in api) return { ok: false, reason: api.reason }
  const f = opts.fetchImpl ?? fetch
  try {
    const res = await f(`${api.baseUrl}/v1/cli/event`, {
      method: 'POST',
      headers: { 'authorization': `Bearer ${api.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(ev),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 3000),
    })
    if (!res.ok) return { ok: false, reason: `http_${res.status}` }
    let action: string | undefined
    try { action = (await res.json() as { action?: string }).action } catch { /* body 不重要 */ }
    return action ? { ok: true, action } : { ok: true }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

// ── 2b. 权限中继(§6.3):登记 + 轮询,总时限 hook 自己掐 ───────────────────────

/** hook 这头的总时限:比 daemon 侧 CLI_PERMISSION_WAIT_MS(120s)多一点,好把「过期」也轮到。 */
export const RELAY_TOTAL_MS = 125_000
/** 一次 GET 最多挂多久(daemon 封顶 25s)。 */
export const RELAY_POLL_MS = 20_000

export interface RelayPermissionOpts {
  fetchImpl?: typeof fetch
  totalMs?: number
  pollMs?: number
  now?: () => number
}

export interface RelayPermissionResult {
  decision: 'allow' | 'deny' | null
  /** 为什么没拿到决定:owner_present / timeout / undelivered / daemon_not_running / http_xxx / deadline … */
  status: string
}

/**
 * 把一条 PermissionRequest 送去微信问主人。拿到 allow / deny 才算有决定;其他一律
 * decision:null,让终端自己弹提示(hook 什么都不输出)。永远不抛。
 */
export async function relayPermission(stateDir: string, req: CliPermissionRequest, opts: RelayPermissionOpts = {}): Promise<RelayPermissionResult> {
  const api = readApiInfo(stateDir)
  if ('reason' in api) return { decision: null, status: api.reason }
  const f = opts.fetchImpl ?? fetch
  const now = opts.now ?? (() => Date.now())
  const totalMs = opts.totalMs ?? RELAY_TOTAL_MS
  const pollMs = opts.pollMs ?? RELAY_POLL_MS
  const headers = { 'authorization': `Bearer ${api.token}`, 'content-type': 'application/json' }
  const deadline = now() + totalMs
  let hash: string
  try {
    const res = await f(`${api.baseUrl}/v1/cli/permission`, {
      method: 'POST', headers, body: JSON.stringify(req), signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return { decision: null, status: `http_${res.status}` }
    const body = await res.json() as { status?: string; hash?: string }
    if (body.status !== 'pending' || !body.hash) return { decision: null, status: body.status ?? 'bad_response' }
    hash = body.hash
  } catch (err) {
    return { decision: null, status: err instanceof Error ? err.message : String(err) }
  }
  while (now() < deadline) {
    const waitMs = Math.max(1, Math.min(pollMs, deadline - now()))
    let status: CliPermissionStatus
    try {
      const res = await f(`${api.baseUrl}/v1/cli/permission?hash=${encodeURIComponent(hash)}&wait_ms=${waitMs}`, {
        method: 'GET', headers, signal: AbortSignal.timeout(waitMs + 5000),
      })
      if (!res.ok) return { decision: null, status: `http_${res.status}` }
      status = (await res.json() as { status?: CliPermissionStatus }).status ?? 'unknown'
    } catch (err) {
      return { decision: null, status: err instanceof Error ? err.message : String(err) }
    }
    if (status === 'allow' || status === 'deny') return { decision: status, status }
    if (status !== 'pending') return { decision: null, status }
  }
  return { decision: null, status: 'deadline' }
}

/**
 * hook 往 stdout 写的答复。两家形状一致(Codex 照抄了 Claude 的):
 * hookSpecificOutput.decision.behavior = allow | deny。
 */
export function permissionDecisionOutput(decision: 'allow' | 'deny'): string {
  const d = decision === 'allow'
    ? { behavior: 'allow' }
    : { behavior: 'deny', message: '主人在微信里拒绝了这次操作' }
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: d } })
}

// ── 3. 安装 / 卸载 / 状态 ─────────────────────────────────────────────────────

/**
 * hook 的命令行。源码模式 process.execPath 是 bun,要带上 cli.ts;编译包里
 * process.execPath 就是 wechat-cc-cli(与 bootstrap/mcp-specs.ts 同一套判断)。
 * 双引号在 bash 与 PowerShell 里都认。
 */
export function hookCommandLine(o: { execPath: string; compiled: boolean; cliEntry: string; source: HookSource }): string {
  const q = (s: string) => `"${s}"`
  return o.compiled
    ? `${q(o.execPath)} hook ${o.source}`
    : `${q(o.execPath)} ${q(o.cliEntry)} hook ${o.source}`
}

export function claudeSettingsPath(home: string): string {
  return join(home, '.claude', 'settings.json')
}

export function codexHooksPath(home: string, env: Record<string, string | undefined>): string {
  return join(env['CODEX_HOME'] || join(home, '.codex'), 'hooks.json')
}

/** Cursor 的用户级 hooks(IDE 与 cursor-agent 共用)。 */
export function cursorHooksPath(home: string): string {
  return join(home, '.cursor', 'hooks.json')
}

interface HookHandler { type: string; command?: string; statusMessage?: string; [k: string]: unknown }
interface MatcherGroup { matcher?: string; hooks: HookHandler[]; [k: string]: unknown }
interface HooksFile { hooks?: Record<string, MatcherGroup[]>; [k: string]: unknown }

/** PermissionRequest 要等答复,所以是同步的;时限要盖过 RELAY_TOTAL_MS。 */
const PERMISSION_HOOK_TIMEOUT_SEC = 150

/**
 * 两家要挂的事件一样:三个事件 fire-and-forget(async),PermissionRequest 同步等微信。
 * Claude 的 Notification(permission_prompt)不挂 —— PermissionRequest 已经覆盖,再挂会重复提醒。
 */
const EVENTS: Record<Exclude<HookSource, 'cursor'>, { event: string; matcher?: string; sync?: boolean }[]> = {
  claude: [
    { event: 'Stop' },
    { event: 'PermissionRequest', sync: true },
    { event: 'UserPromptSubmit' },
    { event: 'SessionEnd' },
  ],
  codex: [
    { event: 'Stop' },
    { event: 'PermissionRequest', sync: true },
    { event: 'UserPromptSubmit' },
    { event: 'SessionEnd' },
  ],
}

function isOurs(h: HookHandler, source: HookSource): boolean {
  if (h.type !== 'command') return false
  if (h.statusMessage === HOOK_STATUS_MESSAGE) return true
  return typeof h.command === 'string' && new RegExp(`(^|\\s)hook ${source}\\s*$`).test(h.command)
}

function readHooksFile(file: string): HooksFile {
  if (!existsSync(file)) return {}
  try {
    const parsed = readJsonFile<unknown>(file)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    return parsed as HooksFile
  } catch (err) {
    // 这个文件里还有主人别的设置;解析不了就别碰,让他自己修。
    throw new Error(`cannot parse ${file}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function writeHooksFile(file: string, cfg: HooksFile): void {
  mkdirSync(dirname(file), { recursive: true })
  // 主人家目录里的配置:常被 stow / chezmoi 链到 dotfiles,写到链接指向的真文件,别把链接换掉。
  writeFileAtomic(file, JSON.stringify(cfg, null, 2) + '\n', { followSymlink: true })
}

/** 去掉自家条目;返回删掉的 handler 数。空组、空事件键一并收掉。 */
function stripOurs(cfg: HooksFile, source: HookSource): number {
  if (!cfg.hooks) return 0
  let removed = 0
  for (const [event, groups] of Object.entries(cfg.hooks)) {
    if (!Array.isArray(groups)) continue
    const kept: MatcherGroup[] = []
    for (const g of groups) {
      const hooks = Array.isArray(g?.hooks) ? g.hooks : []
      const mine = hooks.filter(h => isOurs(h, source)).length
      removed += mine
      const rest = hooks.filter(h => !isOurs(h, source))
      if (rest.length > 0) kept.push({ ...g, hooks: rest })
      else if (mine === 0) kept.push(g)   // 本来就是空组,不是我们的,别动
    }
    if (kept.length > 0) cfg.hooks[event] = kept
    else delete cfg.hooks[event]
  }
  return removed
}

export function installHooks(file: string, source: HookSource, command: string): { changed: boolean } {
  if (source === 'cursor') return installCursorHooks(file, command)
  const cfg = readHooksFile(file)
  const before = JSON.stringify(cfg)
  stripOurs(cfg, source)
  cfg.hooks ??= {}
  for (const { event, matcher, sync } of EVENTS[source]) {
    const handler: HookHandler = sync
      ? { type: 'command', command, timeout: PERMISSION_HOOK_TIMEOUT_SEC, async: false, statusMessage: HOOK_STATUS_MESSAGE }
      : { type: 'command', command, timeout: HOOK_TIMEOUT_SEC, async: true, statusMessage: HOOK_STATUS_MESSAGE }
    const group: MatcherGroup = matcher ? { matcher, hooks: [handler] } : { hooks: [handler] }
    ;(cfg.hooks[event] ??= []).push(group)
  }
  const after = JSON.stringify(cfg)
  if (after === before) return { changed: false }
  writeHooksFile(file, cfg)
  return { changed: true }
}

export function uninstallHooks(file: string, source: HookSource): { changed: boolean; removed: number } {
  if (!existsSync(file)) return { changed: false, removed: 0 }
  if (source === 'cursor') return uninstallCursorHooks(file)
  const cfg = readHooksFile(file)
  const removed = stripOurs(cfg, source)
  if (removed === 0) return { changed: false, removed: 0 }
  if (cfg.hooks && Object.keys(cfg.hooks).length === 0) delete cfg.hooks
  writeHooksFile(file, cfg)
  return { changed: true, removed }
}

export function hookStatus(file: string, source: HookSource): { installed: boolean; command: string | null } {
  if (!existsSync(file)) return { installed: false, command: null }
  let cfg: HooksFile
  try { cfg = readHooksFile(file) } catch { return { installed: false, command: null } }
  if (source === 'cursor') {
    for (const entries of Object.values((cfg.hooks ?? {}) as Record<string, unknown>)) {
      for (const h of (Array.isArray(entries) ? entries : [])) if (isOursCursor(h)) return { installed: true, command: h.command ?? null }
    }
    return { installed: false, command: null }
  }
  for (const groups of Object.values(cfg.hooks ?? {})) {
    if (!Array.isArray(groups)) continue
    for (const g of groups) {
      for (const h of (Array.isArray(g?.hooks) ? g.hooks : [])) {
        if (isOurs(h, source)) return { installed: true, command: h.command ?? null }
      }
    }
  }
  return { installed: false, command: null }
}

// ── 3b. Cursor 的 hooks.json ─────────────────────────────────────────────────

/** `{ version: 1, hooks: { <event>: [{ command, timeout }] } }`;条目没有 type / statusMessage,只能认命令尾巴。 */
interface CursorHookEntry { command?: string; timeout?: number; [k: string]: unknown }

/**
 * Cursor 先只「看」不「拍」(10-15 定):挂 stop / beforeSubmitPrompt / sessionEnd。
 * beforeShellExecution / beforeMCPExecution 不挂 —— 它们对**每一条**命令都触发(不只 Cursor 本来要问的),
 * 我们拿不到决定时只能回 ask,等于关掉 Cursor 自己的 auto-run / 白名单,离开时连 ls 都会发微信卡片。
 * 转换与回话代码保留(cursorPermissionRequest / 决定映射),真机确认 Cursor 对空输出的行为后再开。
 * beforeReadFile / afterFileEdit 之类也不挂:前者每读一个文件都会触发,后者不是主人关心的节点。
 */
const CURSOR_EVENTS: { event: string; sync?: boolean }[] = [
  { event: 'stop' },
  { event: 'beforeSubmitPrompt' },
  { event: 'sessionEnd' },
]

function isOursCursor(h: unknown): h is CursorHookEntry {
  return !!h && typeof h === 'object' && typeof (h as CursorHookEntry).command === 'string' && /(^|\s)hook cursor\s*$/.test((h as CursorHookEntry).command!)
}

function stripOursCursor(cfg: HooksFile): number {
  if (!cfg.hooks || typeof cfg.hooks !== 'object') return 0
  const hooks = cfg.hooks as Record<string, unknown>
  let removed = 0
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue
    const kept = entries.filter(h => !isOursCursor(h))
    removed += entries.length - kept.length
    if (kept.length === entries.length) continue
    if (kept.length > 0) hooks[event] = kept
    else delete hooks[event]
  }
  return removed
}

function installCursorHooks(file: string, command: string): { changed: boolean } {
  const cfg = readHooksFile(file)
  const before = JSON.stringify(cfg)
  stripOursCursor(cfg)
  cfg['version'] ??= 1
  const hooks = (cfg.hooks ??= {}) as unknown as Record<string, CursorHookEntry[]>
  for (const { event, sync } of CURSOR_EVENTS) {
    ;(hooks[event] ??= []).push({ command, timeout: sync ? PERMISSION_HOOK_TIMEOUT_SEC : HOOK_TIMEOUT_SEC })
  }
  if (JSON.stringify(cfg) === before) return { changed: false }
  writeHooksFile(file, cfg)
  return { changed: true }
}

function uninstallCursorHooks(file: string): { changed: boolean; removed: number } {
  const cfg = readHooksFile(file)
  const removed = stripOursCursor(cfg)
  if (removed === 0) return { changed: false, removed: 0 }
  writeHooksFile(file, cfg)
  return { changed: true, removed }
}
