/**
 * hook.ts — `wechat-cc hook …`:终端 claude / codex 会话的 hooks 出口
 * (spec docs/superpowers/specs/2026-09-09-cli-hook-push-design.md)。
 *
 * 三块纯逻辑,cli.ts 只做拼装:
 *   1. normalizeHookPayload:两家的 hook JSON → daemon 认的 CliEvent(不认的事件回 null)
 *   2. postCliEvent:读 internal-api-info.json,POST /v1/cli/event;任何失败都只是 ok:false
 *   3. installHooks / uninstallHooks / hookStatus:幂等写 ~/.claude/settings.json 与
 *      $CODEX_HOME/hooks.json;只动带自己标记的条目,别人的 hook 原样保留
 *
 * 回环守卫:daemon 自己经 SDK 拉起的 claude / codex 继承 daemon 的环境,daemon 启动时
 * 置 WECHAT_CC_DAEMON_CHILD=1(daemon/main.ts);hook 看到就直接退出,不然 daemon 的每个
 * 回合都会被推回微信。
 */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { readJsonFile } from '../lib/read-json-file'
import type { CliEvent, CliSource } from '../core/cli-events'

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
  const r = raw as Raw
  if (str(r['agent_id'])) return null   // 子代理:主会话的 Stop 才是主人关心的
  const session_id = str(r['session_id'])
  const cwd = str(r['cwd'])
  const event = str(r['hook_event_name'])
  if (!session_id || !cwd || !event) return null
  const base = { source, session_id, cwd }
  const withText = (kind: CliEvent['kind'], text: string | undefined): CliEvent =>
    text ? { ...base, kind, text } : { ...base, kind }

  switch (event) {
    case 'Stop':
      return withText('stop', str(r['last_assistant_message']))
    case 'UserPromptSubmit':
      return { ...base, kind: 'prompt' }
    case 'SessionEnd':
      return { ...base, kind: 'session_end' }
    case 'Notification': {
      if (source !== 'claude') return null
      if (r['notification_type'] !== 'permission_prompt') return null
      return withText('permission', str(r['message']))
    }
    case 'PermissionRequest': {
      if (source !== 'codex') return null
      const tool = str(r['tool_name']) ?? 'tool'
      const summary = summarizeToolInput(r['tool_input'])
      return withText('permission', summary ? `${tool}: ${summary}` : tool)
    }
    default:
      return null
  }
}

// ── 2. POST 给 daemon ─────────────────────────────────────────────────────────

export interface PostCliEventOpts {
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export type PostCliEventResult =
  | { ok: true; action?: string }
  | { ok: false; reason: string }

/**
 * 读 `<stateDir>/internal-api-info.json`(与 `wechat-cc agent` 同源)拿 baseUrl + FILE token,
 * POST /v1/cli/event。永远不抛:daemon 没跑、超时、非 2xx 都只是 ok:false。
 */
export async function postCliEvent(stateDir: string, ev: CliEvent, opts: PostCliEventOpts = {}): Promise<PostCliEventResult> {
  const infoPath = join(stateDir, 'internal-api-info.json')
  if (!existsSync(infoPath)) return { ok: false, reason: 'daemon_not_running' }
  let info: { baseUrl?: string; tokenFilePath?: string }
  try { info = readJsonFile(infoPath) } catch { return { ok: false, reason: 'info_malformed' } }
  if (!info.baseUrl || !info.tokenFilePath) return { ok: false, reason: 'info_incomplete' }
  let token: string
  try { token = readFileSync(info.tokenFilePath, 'utf8').trim() } catch { return { ok: false, reason: 'token_unreadable' } }
  const f = opts.fetchImpl ?? fetch
  try {
    const res = await f(`${info.baseUrl}/v1/cli/event`, {
      method: 'POST',
      headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' },
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

interface HookHandler { type: string; command?: string; statusMessage?: string; [k: string]: unknown }
interface MatcherGroup { matcher?: string; hooks: HookHandler[]; [k: string]: unknown }
interface HooksFile { hooks?: Record<string, MatcherGroup[]>; [k: string]: unknown }

/** 每家要挂的事件;Claude 的权限通知要 matcher 过滤,别的通知(登录成功之类)不关我们事。 */
const EVENTS: Record<HookSource, { event: string; matcher?: string }[]> = {
  claude: [
    { event: 'Stop' },
    { event: 'Notification', matcher: 'permission_prompt' },
    { event: 'UserPromptSubmit' },
    { event: 'SessionEnd' },
  ],
  codex: [
    { event: 'Stop' },
    { event: 'PermissionRequest' },
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
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n')
  renameSync(tmp, file)
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
  const cfg = readHooksFile(file)
  const before = JSON.stringify(cfg)
  stripOurs(cfg, source)
  cfg.hooks ??= {}
  for (const { event, matcher } of EVENTS[source]) {
    const handler: HookHandler = { type: 'command', command, timeout: HOOK_TIMEOUT_SEC, async: true, statusMessage: HOOK_STATUS_MESSAGE }
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
