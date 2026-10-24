/**
 * claude-live-window.ts — 手机 / 微信对一条终端会话「说一句」时,那条 Claude 会话如果还开在电脑的窗口里,
 * 就把话送进那个窗口,而不是另起一个 `claude -p --resume` 副本(2026-10-18 主人)。
 *
 * 为什么:副本跑的那一轮开着的窗口看不见,两边还会同时写同一条会话、同一个文件夹。
 *
 * 怎么找:Claude Code 每个活着的会话在 `<配置目录>/sessions/<pid>.json` 登记(sessionId、name、kind),
 * 进程还在 ⇒ 窗口开着。怎么送:Claude Code 自带的会话间消息(SendMessage)—— 起一个只许用
 * SendMessage 的 `claude -p` 小进程,按名字把原话转进去;到达时在那边是一条
 * `<cross-session-message from-name="tendhearth-phone">`。不碰它私有的套接字协议:那是内部接口,随版本会变。
 *
 * 只读登记文件,不写 ~/.claude 下任何东西。
 */
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readJsonFile } from '../lib/read-json-file'

/** 同 cli-reply-handler 的 Runner(这里自己写一份,免得两个文件互相 import)。 */
type Runner = (cmd: string, args: string[], cwd: string, timeoutMs: number) => Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>

export interface LiveWindow { pid: number; name: string; kind: string; status?: string }

/** 发信那个小进程在对方那边显示的名字。 */
export const RELAY_SENDER_NAME = 'tendhearth-phone'
/** 送一句话最多等这么久(实测 ~15 秒)。 */
export const RELAY_TIMEOUT_MS = 90_000
const SENT = 'RELAY_SENT'

type Entry = { pid?: unknown; sessionId?: unknown; name?: unknown; kind?: unknown; status?: unknown; procStart?: unknown }
/** 进程活着吗;procStart = 登记里记的进程启动时间(`ps -o lstart` 的格式),给了就要对得上。 */
type Alive = (pid: number, procStart?: string) => boolean

/**
 * 从登记里挑出这条会话开着的窗口。要求:sessionId 对得上、进程活着、有名字,
 * 而且这个名字在活着的会话里只有一个(SendMessage 按名字投递,重名就可能送错窗口 ⇒ 不送)。
 */
export function pickLiveWindow(entries: Entry[], sessionId: string, alive: Alive): LiveWindow | null {
  const live = entries.filter((e): e is Entry & { pid: number } => typeof e.pid === 'number' && e.pid > 0 && alive(e.pid, typeof e.procStart === 'string' ? e.procStart : undefined))
  const me = live.find(e => e.sessionId === sessionId)
  if (!me || typeof me.name !== 'string' || !me.name.trim()) return null
  if (live.filter(e => e.name === me.name).length > 1) return null
  return { pid: me.pid, name: me.name, kind: typeof me.kind === 'string' ? me.kind : 'interactive', ...(typeof me.status === 'string' ? { status: me.status } : {}) }
}

export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude')
}

/**
 * 只看 kill(pid,0) 不够:窗口被 kill -9 / 崩掉时登记文件留下,pid 被别的进程复用后会一直被当成「窗口开着」,
 * 话只往一个不存在的名字送、永远说不进去(评审 10-19 #4)。登记里有 procStart 就再跟 ps 报的启动时间对一次;
 * ps 不可用(Windows)/ 读不出 ⇒ 退回只看 kill。
 */
export function pidAlive(pid: number, procStart?: string, lstart: (pid: number) => string | null = psStart): boolean {
  try { process.kill(pid, 0) }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== 'EPERM') return false }
  if (!procStart) return true
  const actual = lstart(pid)
  return actual === null || squash(actual) === squash(procStart)
}
const squash = (t: string) => t.trim().replace(/\s+/g, ' ')
function psStart(pid: number): string | null {
  if (process.platform === 'win32') return null
  // Claude Code 记的 procStart 是 UTC + C 区域格式;ps 默认按本机时区与语言打(中文系统是「一 10月/19 …」),
  // 不钉死就会把每个开着的窗口都判成「换了进程」。
  try { return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' } }).trim() || null }
  catch { return null }
}
/** 一次读登记里每个 pid 只问一遍(liveSessionIds 对每条都挑一次,不缓存就是 n² 次 ps)。 */
function once(alive: Alive): Alive {
  const seen = new Map<string, boolean>()
  return (pid, procStart) => { const k = `${pid}|${procStart ?? ''}`; let v = seen.get(k); if (v === undefined) { v = alive(pid, procStart); seen.set(k, v) } return v }
}

/** 开着窗口的会话 id(同样要求进程活着、名字唯一)—— 手机列表一次读一遍,不逐条读。 */
export function liveSessionIds(opts: { dir?: string; alive?: Alive } = {}): Set<string> {
  const entries = readEntries(opts.dir)
  const out = new Set<string>()
  const alive = once(opts.alive ?? pidAlive)
  for (const e of entries) {
    if (typeof e.sessionId === 'string' && pickLiveWindow(entries, e.sessionId, alive)) out.add(e.sessionId)
  }
  return out
}

function readEntries(dirOpt?: string): Entry[] {
  const dir = dirOpt ?? join(claudeConfigDir(), 'sessions')
  let names: string[]
  try { names = readdirSync(dir).filter(n => /^\d+\.json$/.test(n)) } catch { return [] }
  const entries: Entry[] = []
  for (const n of names) {
    try { entries.push(readJsonFile<Entry>(join(dir, n))) } catch { /* 写到一半 / 坏了:跳过 */ }
  }
  return entries
}

export function findLiveWindow(sessionId: string, opts: { dir?: string; alive?: Alive } = {}): LiveWindow | null {
  return pickLiveWindow(readEntries(opts.dir), sessionId, once(opts.alive ?? pidAlive))
}

/** 主人自己「@码」/ 手机说一句时,转进窗口那段话的第一行。 */
export const RELAY_OWNER_HEADER = '主人从手机发来一句话(Tendhearth CC 转达,原话如下):'

/**
 * 转进窗口的那段话:第一行说清楚是谁、从哪来(对方窗口折叠时只露第一行)。
 * header:CC 自己代主人说(terminal_say,2026-10-24)时换一句 —— 那不是主人原话,对方要知道回复会被转回去。
 */
export function relayMessage(text: string, header: string = RELAY_OWNER_HEADER): string {
  return `${header}\n${text}`
}

/** 给发信小进程的指令:只许调一次 SendMessage、原样转、成功回 RELAY_SENT。 */
export function relayPrompt(windowName: string, text: string, header?: string): string {
  // 原话里的 </relay> 会提前合上包裹、让后面的字被小进程当指令读(评审 10-19 #5):拆开那个标签,其余一字不动。
  const body = relayMessage(text, header).replace(/<\/?relay\b/gi, m => m.replace('<', '‹'))
  return [
    `Call the SendMessage tool exactly once with to = ${JSON.stringify(windowName)} and message = the text inside <relay> below, copied exactly (same characters, same line breaks).`,
    `Do not call any other tool. If the send succeeds, reply with exactly ${SENT}. Otherwise reply with RELAY_FAILED followed by the error.`,
    '<relay>',
    body,
    '</relay>',
  ].join('\n')
}

/**
 * 发信小进程只给 SendMessage 一个工具(`--tools`,不是 allowedTools:换成免审模式也拿不到别的)。
 * 权限模式跟 daemon 的 --dangerously 姿态走:主人的终端窗口多半是免审的,两边模式不同时
 * 对方会先把这句话扣下等主人在终端点头 —— 那样也送到了,只是慢一步。
 */
export function relayCommand(windowName: string, text: string, dangerously: boolean, bin = 'claude', header?: string): { cmd: string; args: string[] } {
  return {
    // bin = daemon 启动时解析出的 claude(device-e2e 10-20 真机:launchd 的 PATH 里没有 ~/.local/bin,裸 `claude` 起不来)
    cmd: bin,
    args: ['-p', '--model', 'haiku', '--name', RELAY_SENDER_NAME, '--no-session-persistence', '--tools', 'SendMessage',
      ...(dangerously ? ['--permission-mode', 'bypassPermissions'] : ['--allowedTools', 'SendMessage']), '--', relayPrompt(windowName, text, header)],
  }
}

export type RelayResult = { ok: true } | { ok: false; error: string }

export async function relayToWindow(w: LiveWindow, text: string, deps: { run: Runner; cwd: string; dangerously: boolean; bin?: string; header?: string }): Promise<RelayResult> {
  const { cmd, args } = relayCommand(w.name, text, deps.dangerously, deps.bin, deps.header)
  const r = await deps.run(cmd, args, deps.cwd, RELAY_TIMEOUT_MS)
  if (r.timedOut) return { ok: false, error: '送进窗口超时' }
  // 只认最后一行就是 RELAY_SENT:「RELAY_FAILED … not RELAY_SENT」之类的回显不能算送到。
  if (r.stdout.trim().split('\n').pop()?.trim() === SENT) return { ok: true }
  const why = (r.stdout.trim() || r.stderr.trim()).split('\n')[0]?.slice(0, 200)
  return { ok: false, error: why || `exit ${r.code ?? '?'}` }
}

/**
 * 不开着时退回 `claude -p --resume`:要在会话**开始时**的文件夹里起,Claude 才找得到它
 * (登记处的 cwd 是最近一次 hook 报的,会话中途进了 worktree 就对不上 —— 10-18 手机那句就是这样丢的)。
 * 从记录开头找第一个 "cwd";找不到 ⇒ null(照旧用登记处的)。
 */
export function transcriptStartCwd(head: string): string | null {
  for (const line of head.split('\n')) {
    if (!line.includes('"cwd"')) continue
    try { const o = JSON.parse(line) as { cwd?: unknown }; if (typeof o.cwd === 'string' && o.cwd) return o.cwd } catch { /* 截断的行 */ }
  }
  return null
}
