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
import { parseCliReply } from '../core/cli-reply'
import { resumeCommand } from '../core/cli-reply'
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

export interface CliReplyHandlerDeps {
  hub: Pick<CliEventHub, 'lookup' | 'sessions'>
  isOwner: (chatId: string) => boolean
  sendMessage: (chatId: string, text: string) => Promise<unknown>
  sharePage: (title: string, markdown: string, chatId: string) => Promise<string | null>
  run?: Runner
  holdBusy?: (label: string) => () => void
  log: (tag: string, line: string) => void
  dangerously: boolean
  localMachine?: string
  readFile?: (path: string) => string
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
  const run = deps.run ?? defaultRunner
  const readFile = deps.readFile ?? readTail
  const say = (chatId: string, text: string) => deps.sendMessage(chatId, text).catch(err => deps.log('CLI_REPLY', `send failed: ${err instanceof Error ? err.message : String(err)}`))

  function describe(s: CliSessionInfo): string {
    return `${s.source} · 会话 ${s.session_id.slice(0, 6)}${s.machine && deps.localMachine && s.machine !== deps.localMachine ? ` · 那边(${s.machine})` : ''}`
  }

  function notFound(code: string): string {
    const recent = deps.hub.sessions().slice(0, 5).map(s => `${s.session_id.slice(0, 6)}(${s.source})`)
    return `没见过会话码「${code}」。${recent.length ? `最近见过的:${recent.join('、')}` : '还没有终端会话报到过。'}`
  }

  function isRemote(s: CliSessionInfo): boolean {
    return !!s.machine && !!deps.localMachine && s.machine !== deps.localMachine
  }

  async function view(chatId: string, code: string): Promise<void> {
    const s = deps.hub.lookup(code)
    if (!s) { await say(chatId, notFound(code)); return }
    if (isRemote(s)) { await say(chatId, `${describe(s)} 在别的机器上,这台机看不到它的记录(下一步接)。`); return }
    if (!s.transcript_path) { await say(chatId, `${describe(s)} 没报过记录路径,看不了。`); return }
    let md: string
    try { md = renderTranscriptTail(readFile(s.transcript_path), s.source, { title: describe(s) }) }
    catch (err) { await say(chatId, `读不到 ${describe(s)} 的记录:${err instanceof Error ? err.message : String(err)}`); return }
    const url = await deps.sharePage(describe(s), md, chatId).catch(() => null)
    await say(chatId, url ? `${describe(s)} 最近的对话:${url}` : `${describe(s)}:\n${stripMarkdown(md).slice(0, INLINE_MAX)}`)
  }

  async function sayTo(chatId: string, code: string, text: string): Promise<void> {
    const s = deps.hub.lookup(code)
    if (!s) { await say(chatId, notFound(code)); return }
    if (isRemote(s)) { await say(chatId, `${describe(s)} 在别的机器上,这台机接不上它(下一步接)。`); return }
    const { cmd, args } = resumeCommand(s.source, s.session_id, text, deps.dangerously)
    await say(chatId, `收到,${describe(s)} 接着跑…(最多等 ${Math.round(RESUME_TIMEOUT_MS / 60_000)} 分钟)`)
    const release = deps.holdBusy?.(`cli-resume:${s.session_id.slice(0, 6)}`) ?? (() => {})
    void (async () => {
      try {
        deps.log('CLI_REPLY', `resume ${s.source}/${s.session_id.slice(0, 6)} in ${s.cwd}`)
        const r = await run(cmd, args, s.cwd, RESUME_TIMEOUT_MS)
        const out = r.stdout.trim()
        if (r.timedOut) { await say(chatId, `${describe(s)} 跑了 ${Math.round(RESUME_TIMEOUT_MS / 60_000)} 分钟还没完,先停了。${out ? `\n目前的输出:\n${stripMarkdown(out).slice(0, INLINE_MAX)}` : ''}`); return }
        if (r.code !== 0 && !out) { await say(chatId, `${describe(s)} 没跑起来(exit ${r.code ?? '?'}):${r.stderr.trim().slice(0, 400) || '没有错误输出'}`); return }
        const plain = stripMarkdown(out || '(没有输出)')
        if (plain.length > INLINE_MAX) {
          const url = await deps.sharePage(`${describe(s)} 的回复`, out, chatId).catch(() => null)
          await say(chatId, `🔔 ${describe(s)} 回来了\n${plain.slice(0, INLINE_MAX - 1)}…${url ? `\n全文:${url}` : ''}`)
        } else {
          await say(chatId, `🔔 ${describe(s)} 回来了\n${plain}`)
        }
      } catch (err) {
        await say(chatId, `${describe(s)} 出错:${err instanceof Error ? err.message : String(err)}`)
      } finally { release() }
    })()
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
