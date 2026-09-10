/**
 * cli-reply-handler.ts — 「看 码」「@码 文本」的执行(spec 2026-09-09-cli-hook-push §6.4)。
 *
 * 只认主人。看:读 transcript 尾巴 → share_page → 回链接。说:起一个新进程接着原会话跑
 * (claude -p --resume / codex exec resume),跑完把结果回微信;跑的期间登记 busy,空闲
 * 自重启才不会掐在半程。新进程继承 daemon 的环境(WECHAT_CC_DAEMON_CHILD=1),它自己的
 * hooks 静默 —— 结果由这里回,不会再推一次「完成了」。
 *
 * 那边(别的机器)的会话:v1 先说明白「暂时只能看这台机的」,转发是下一步。
 */
import { spawn } from 'node:child_process'
import { readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { parseCliReply, resumeCommand } from '../core/cli-reply'
import { renderTranscriptTail } from '../core/cli-transcript'
import { stripMarkdown, INLINE_MAX, type CliEventHub, type CliSessionInfo } from '../core/cli-events'

export const RESUME_TIMEOUT_MS = 10 * 60_000
const TRANSCRIPT_READ_MAX = 512 * 1024

export interface RunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }
export type Runner = (cmd: string, args: string[], cwd: string, timeoutMs: number) => Promise<RunResult>

/**
 * 起进程、收输出、到点掐掉。掐的是**进程组**(POSIX 下 detached 起),不然 `claude` 下面
 * 还挂着的子进程会拖住管道,'close' 永远不来。exit 之后再等一小会儿冲掉尾巴就算完。
 */
export const defaultRunner: Runner = (cmd, args, cwd, timeoutMs) => new Promise((resolve) => {
  const posix = process.platform !== 'win32'
  const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: posix })
  let stdout = '', stderr = '', timedOut = false, done = false
  const finish = (code: number | null, extraErr?: string) => {
    if (done) return
    done = true
    clearTimeout(t)
    resolve({ code, stdout, stderr: extraErr ? stderr + extraErr : stderr, timedOut })
  }
  const killAll = () => {
    try { if (posix && child.pid) process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM') } catch { /* 已经没了 */ }
  }
  const t = setTimeout(() => { timedOut = true; killAll() }, timeoutMs)
  child.stdout.on('data', (b) => { stdout += String(b) })
  child.stderr.on('data', (b) => { stderr += String(b) })
  child.on('error', (err) => finish(null, err instanceof Error ? err.message : String(err)))
  child.on('close', (code) => finish(code))
  // 管道被孙进程拖住时 close 不来:exit 之后给 500ms 冲输出,然后就按已收到的算。
  child.on('exit', (code) => { setTimeout(() => finish(code), 500).unref?.() })
})

export interface CliReplyCoreDeps {
  hub: Pick<CliEventHub, 'lookup' | 'sessions'>
  run?: Runner
  holdBusy?: (label: string) => () => void
  log: (tag: string, line: string) => void
  dangerously: boolean
  readFile?: (path: string) => string
}

export interface CliReplyHandlerDeps extends CliReplyCoreDeps {
  isOwner: (chatId: string) => boolean
  sendMessage: (chatId: string, text: string) => Promise<unknown>
  sharePage: (title: string, markdown: string, chatId: string) => Promise<string | null>
  localMachine?: string
  /** 那边(经 A2A 转来的)会话:脑把「看 / 说」转给那只手执行(§6.5)。缺席 ⇒ 回「接不上」。 */
  remote?: {
    view(s: CliSessionInfo): Promise<{ ok: true; markdown: string } | { ok: false; error: string }>
    say(s: CliSessionInfo, text: string): Promise<{ ok: boolean; error?: string }>
  }
}

export type ResumeOutcome = { kind: 'ok' | 'timeout' | 'failed'; text: string }

/** 「看」「说」的本机执行,不知道微信;WeChat 面与手侧 A2A 面都用它。 */
export interface CliReplyCore {
  viewMarkdown(s: CliSessionInfo, title: string): { ok: true; markdown: string } | { ok: false; error: string }
  resume(s: CliSessionInfo, text: string): Promise<ResumeOutcome>
}

export function makeCliReplyCore(deps: CliReplyCoreDeps): CliReplyCore {
  const run = deps.run ?? defaultRunner
  const readFile = deps.readFile ?? readTail
  return {
    viewMarkdown(s, title) {
      if (!s.transcript_path) return { ok: false, error: '没报过记录路径,看不了' }
      try { return { ok: true, markdown: renderTranscriptTail(readFile(s.transcript_path), s.source, { title }) } }
      catch (err) { return { ok: false, error: `读不到记录:${err instanceof Error ? err.message : String(err)}` } }
    },
    async resume(s, text) {
      const { cmd, args } = resumeCommand(s.source, s.session_id, text, deps.dangerously)
      const release = deps.holdBusy?.(`cli-resume:${s.session_id.slice(0, 6)}`) ?? (() => {})
      try {
        deps.log('CLI_REPLY', `resume ${s.source}/${s.session_id.slice(0, 6)} in ${s.cwd}`)
        const r = await run(cmd, args, s.cwd, RESUME_TIMEOUT_MS)
        const out = r.stdout.trim()
        if (r.timedOut) return { kind: 'timeout', text: out }
        if (r.code !== 0 && !out) return { kind: 'failed', text: `exit ${r.code ?? '?'}:${r.stderr.trim().slice(0, 400) || '没有错误输出'}` }
        return { kind: 'ok', text: out || '(没有输出)' }
      } catch (err) {
        return { kind: 'failed', text: err instanceof Error ? err.message : String(err) }
      } finally { release() }
    },
  }
}

/**
 * 手侧的 A2A 面(脑调 /a2a/cli/reply):看 → 直接回 markdown 给脑去做页面;
 * 说 → 起 resume,跑完经 notifyBrain 把结果送回脑(脑当成一条 [A2A:手] 通知发给主人)。
 */
export function makeHandReplyExecutor(core: CliReplyCore, deps: {
  hub: Pick<CliEventHub, 'lookup'>
  notifyBrain: (text: string) => Promise<void>
  log: (tag: string, line: string) => void
}): (req: { kind: 'view' | 'say'; session_id: string; text?: string }) => Promise<{ ok: boolean; markdown?: string; error?: string }> {
  return async (req) => {
    const s = deps.hub.lookup(req.session_id)
    if (!s) return { ok: false, error: 'session_unknown' }
    const label = `${s.source} · 会话 ${s.session_id.slice(0, 6)}`
    if (req.kind === 'view') {
      const v = core.viewMarkdown(s, label)
      return v.ok ? { ok: true, markdown: v.markdown } : { ok: false, error: v.error }
    }
    if (!req.text) return { ok: false, error: 'text_required' }
    void core.resume(s, req.text).then(async (r) => {
      const plain = stripMarkdown(r.text).slice(0, INLINE_MAX)
      const msg = r.kind === 'ok' ? `🔔 ${label} 回来了\n${plain}`
        : r.kind === 'timeout' ? `${label} 跑了 ${Math.round(RESUME_TIMEOUT_MS / 60_000)} 分钟还没完,先停了。${plain ? `\n目前的输出:\n${plain}` : ''}`
        : `${label} 没跑起来(${plain})`
      await deps.notifyBrain(msg).catch(err => deps.log('CLI_REPLY', `notify brain failed: ${err instanceof Error ? err.message : String(err)}`))
    })
    return { ok: true }
  }
}

/** 只读文件尾巴,transcript 可能有几十 MB。 */
export function readTail(path: string, max = TRANSCRIPT_READ_MAX): string {
  const size = statSync(path).size
  if (size <= max) return readFileSync(path, 'utf8')
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(max)
    readSync(fd, buf, 0, max, size - max)
    const s = buf.toString('utf8')
    return s.slice(s.indexOf('\n') + 1)   // 丢掉被截断的第一行
  } finally { closeSync(fd) }
}

export interface CliReplyHandler {
  /** true = 这句话是给终端会话的,已处理(或已回绝);false = 不是,交给后面的中间件。 */
  handle(text: string, chatId: string): Promise<boolean>
}

export function makeCliReplyHandler(deps: CliReplyHandlerDeps): CliReplyHandler {
  const core = makeCliReplyCore(deps)
  const say = (chatId: string, text: string) => deps.sendMessage(chatId, text).catch(err => deps.log('CLI_REPLY', `send failed: ${err instanceof Error ? err.message : String(err)}`))

  function describe(s: CliSessionInfo): string {
    return `${s.source} · 会话 ${s.session_id.slice(0, 6)}${s.machine && deps.localMachine && s.machine !== deps.localMachine ? ` · 那边(${s.machine})` : ''}`
  }

  function notFound(code: string): string {
    const recent = deps.hub.sessions().slice(0, 5).map(s => `${s.session_id.slice(0, 6)}(${s.source})`)
    return `没见过会话码「${code}」。${recent.length ? `最近见过的:${recent.join('、')}` : '还没有终端会话报到过。'}`
  }

  /** 经 A2A 从手转来的会话 —— 记录与进程都在那只手上。 */
  function isRemote(s: CliSessionInfo): boolean {
    return !!s.origin_agent || (!!s.machine && !!deps.localMachine && s.machine !== deps.localMachine)
  }

  async function sendMarkdown(chatId: string, label: string, md: string): Promise<void> {
    const url = await deps.sharePage(label, md, chatId).catch(() => null)
    await say(chatId, url ? `${label} 最近的对话:${url}` : `${label}:\n${stripMarkdown(md).slice(0, INLINE_MAX)}`)
  }

  async function view(chatId: string, code: string): Promise<void> {
    const s = deps.hub.lookup(code)
    if (!s) { await say(chatId, notFound(code)); return }
    if (isRemote(s)) {
      if (!deps.remote) { await say(chatId, `${describe(s)} 在别的机器上,这台机接不上它。`); return }
      const r = await deps.remote.view(s).catch(err => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }))
      if (!r.ok) { await say(chatId, `${describe(s)}:那边说 ${r.error}`); return }
      await sendMarkdown(chatId, describe(s), r.markdown)
      return
    }
    const v = core.viewMarkdown(s, describe(s))
    if (!v.ok) { await say(chatId, `${describe(s)} ${v.error}。`); return }
    await sendMarkdown(chatId, describe(s), v.markdown)
  }

  async function sayTo(chatId: string, code: string, text: string): Promise<void> {
    const s = deps.hub.lookup(code)
    if (!s) { await say(chatId, notFound(code)); return }
    if (isRemote(s)) {
      if (!deps.remote) { await say(chatId, `${describe(s)} 在别的机器上,这台机接不上它。`); return }
      const r = await deps.remote.say(s, text).catch(err => ({ ok: false, error: err instanceof Error ? err.message : String(err) }))
      await say(chatId, r.ok ? `收到,${describe(s)} 在那边接着跑…跑完那边会回一条。` : `${describe(s)}:那边没接上(${r.error ?? '未知'})。`)
      return
    }
    await say(chatId, `收到,${describe(s)} 接着跑…(最多等 ${Math.round(RESUME_TIMEOUT_MS / 60_000)} 分钟)`)
    void core.resume(s, text).then(async (r) => {
      if (r.kind === 'timeout') { await say(chatId, `${describe(s)} 跑了 ${Math.round(RESUME_TIMEOUT_MS / 60_000)} 分钟还没完,先停了。${r.text ? `\n目前的输出:\n${stripMarkdown(r.text).slice(0, INLINE_MAX)}` : ''}`); return }
      if (r.kind === 'failed') { await say(chatId, `${describe(s)} 没跑起来(${r.text})`); return }
      const plain = stripMarkdown(r.text)
      if (plain.length > INLINE_MAX) {
        const url = await deps.sharePage(`${describe(s)} 的回复`, r.text, chatId).catch(() => null)
        await say(chatId, `🔔 ${describe(s)} 回来了\n${plain.slice(0, INLINE_MAX - 1)}…${url ? `\n全文:${url}` : ''}`)
      } else {
        await say(chatId, `🔔 ${describe(s)} 回来了\n${plain}`)
      }
    })
  }

  return {
    async handle(text, chatId) {
      const parsed = parseCliReply(text)
      if (!parsed) return false
      if (!deps.isOwner(chatId)) return false   // 不是主人:当普通消息,别暴露会话码这套
      if (parsed.kind === 'view') await view(chatId, parsed.code)
      else await sayTo(chatId, parsed.code, parsed.text)
      return true
    },
  }
}
