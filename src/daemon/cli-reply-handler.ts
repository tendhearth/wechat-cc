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
import { decideCall, unprotectedMessage, type NetworkGate } from '../lib/network-gate'
import { codexCallTarget } from '../lib/codex-target'
import { spawn } from 'node:child_process'
import { wrapForProcessTree } from '../lib/jobspawn'
import { readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { parseCliReply, resumeCommand } from '../core/cli-reply'
import { renderTranscriptTail } from '../core/cli-transcript'
import { renderTurnSteps } from '../core/cli-activity'
import { stripMarkdown, INLINE_MAX, type CliEventHub, type CliSessionInfo } from '../core/cli-events'
import { cliSourceLabel, formatCliSessionDigest, type CliDigestView } from '../core/cli-session-digest'
import { formatOverseerToday, type OverseerToday } from '../core/overseer-today'
import type { LiveWindow, RelayResult } from './claude-live-window'

export const RESUME_TIMEOUT_MS = 10 * 60_000
const TRANSCRIPT_READ_MAX = 512 * 1024

export interface RunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; closed?:boolean }
export type Runner = (cmd: string, args: string[], cwd: string, timeoutMs: number) => Promise<RunResult>

/**
 * 起进程、收输出、到点掐掉。掐的是**进程组**(POSIX 下 detached 起),不然 `claude` 下面
 * 还挂着的子进程会拖住管道,'close' 永远不来。exit 之后再等一小会儿冲掉尾巴就算完。
 *
 * win32 上没有进程组:`killAll` 的 else 分支只杀 `claude` / `codex` 本身,它们自己开的
 * MCP 与子代理留下继续跑(而且照旧拖着管道)。所以 spawn 这一侧套一层 `cc-jobspawn`
 * (`wrapForProcessTree`,只在 win32 生效),杀它等于杀整棵树 —— 下面两处 kill 没动。
 */
export const defaultRunner: Runner = (cmd, args, cwd, timeoutMs) => new Promise((resolve) => {
  const posix = process.platform !== 'win32'
  const wrapped = wrapForProcessTree(cmd, args)
  const child = spawn(wrapped.command, wrapped.args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: posix })
  let stdout = '', stderr = '', timedOut = false, done = false
  const closed=()=>{if(!child.pid)return false;if(!posix)return child.exitCode!==null;try{process.kill(-child.pid,0);return false}catch(error){return (error as NodeJS.ErrnoException).code==='ESRCH'}}
  const finish = (code: number | null, extraErr?: string) => {
    if (done) return
    done = true
    clearTimeout(t)
    resolve({ code, stdout, stderr: extraErr ? stderr + extraErr : stderr, timedOut,closed:closed() })
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
  executionConflict?:(s:CliSessionInfo)=>boolean
  reserveExecution?:(s:CliSessionInfo)=>(closed:boolean)=>void
  /**
   * observe(可选):接着跑的这一轮也记进终端会话登记处 —— 开跑记 running、跑完记 idle + 最后一句
   * (`claude -p --resume` 继承 WECHAT_CC_DAEMON_CHILD=1,它自己的 hooks 不报)。手机据此看到「在跑」
   * 和这轮的结果,也据此拒绝在跑时再说一句。缺席(老测试)⇒ 不记。
   */
  hub: Pick<CliEventHub, 'lookup' | 'sessions'> & Partial<Pick<CliEventHub, 'observe'>>
  run?: Runner
  holdBusy?: (label: string) => () => void
  log: (tag: string, line: string) => void
  dangerously: boolean
  /** daemon 启动时解析出的 claude(resolveClaudeBinary);没给 ⇒ 裸名字。 */
  claudeBin?: string
  readFile?: (path: string) => string
  /** 网络闸门(2026-10-02):起 `claude -p --resume` / `codex exec resume` 之前问一次。 */
  networkGate?: NetworkGate
  /**
   * 开着的窗口(2026-10-18):这条会话还开在电脑的终端窗口里 ⇒ 把话送进那个窗口(claude-live-window.ts),
   * 不另起 resume 副本。缺席(老测试 / 不是 Claude)⇒ 照旧 resume。
   */
  liveWindow?: {
    find(s: CliSessionInfo): LiveWindow | null
    relay(w: LiveWindow, text: string): Promise<RelayResult>
  }
  /** Claude 的 resume 要在会话开始时的文件夹里起(从记录开头读);缺席 / 读不到 ⇒ 用登记处的 cwd。 */
  startCwd?: (s: CliSessionInfo) => string | null
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
  /**
   * 「终端」:登记处的列表(等你批准的在前,带中继开出去的码)。缺席 ⇒ 不认「终端」这句,
   * 交给后面(老测试 / 没接登记处)。
   */
  listSessions?: () => CliDigestView[]
  /**
   * 「日报」:过去 24 小时终端 + 一起做的一眼看完(core/overseer-today.ts)。缺席 ⇒ 不认「日报」,
   * 交给后面。只在被问时算,不定时、不主动发。
   */
  today?: () => OverseerToday
  now?: () => number
}

/** relayed = 送进了开着的窗口(text 是窗口名),结果由那个窗口自己的 hooks 照常报。 */
export type ResumeOutcome = { kind: 'ok' | 'timeout' | 'failed' | 'relayed'; text: string }

/** 「看」「说」的本机执行,不知道微信;WeChat 面与手侧 A2A 面都用它。 */
export interface CliReplyCore {
  viewMarkdown(s: CliSessionInfo, title: string): { ok: true; markdown: string } | { ok: false; error: string }
  resume(s: CliSessionInfo, text: string): Promise<ResumeOutcome>
  /** 这条会话开在电脑的窗口里(话会送进窗口,所以它在跑也能说)。 */
  live(s: CliSessionInfo): LiveWindow | null
}

export function makeCliReplyCore(deps: CliReplyCoreDeps): CliReplyCore {
  const run = deps.run ?? defaultRunner
  const readFile = deps.readFile ?? readTail
  const live = (s: CliSessionInfo): LiveWindow | null => {
    if (s.source !== 'claude' || !deps.liveWindow) return null
    try { return deps.liveWindow.find(s) } catch { return null }
  }
  /** 每条会话一条发信队列(在 return 之前建:relayInner 是提升的函数,但这个 Map 不是)。 */
  const relayChains = new Map<string, Promise<unknown>>()
  return {
    live,
    viewMarkdown(s, title) {
      if (!s.transcript_path) return { ok: false, error: '没报过记录路径,看不了' }
      try {
        const jsonl = readFile(s.transcript_path)
        // 对话之后补一段这一轮做过的步骤(看码 2026-10-17)。
        const steps = renderTurnSteps(jsonl, s.source)
        return { ok: true, markdown: renderTranscriptTail(jsonl, s.source, { title }) + (steps ? `\n${steps}` : '') }
      }
      catch (err) { return { ok: false, error: `读不到记录:${err instanceof Error ? err.message : String(err)}` } }
    },
    async resume(s, text) {
      const w = live(s)
      if (w) return relayInner(s, w, text)
      const ident = { source: s.source, session_id: s.session_id, cwd: s.cwd, ...(s.machine ? { machine: s.machine } : {}), ...(s.transcript_path ? { transcript_path: s.transcript_path } : {}), ...(s.origin_agent ? { origin_agent: s.origin_agent } : {}) }
      const note = (ev: { kind: 'prompt' } | { kind: 'stop'; text: string }) => { try { deps.hub.observe?.({ ...ident, ...ev }) } catch { /* 登记处出错不影响接着跑 */ } }
      note({ kind: 'prompt' })
      const r = await resumeInner(s, text)
      note({ kind: 'stop', text: r.kind === 'ok' ? r.text : r.kind === 'timeout' ? `跑了 ${Math.round(RESUME_TIMEOUT_MS / 60_000)} 分钟还没完,先停了。${r.text ? ` ${r.text}` : ''}` : `没跑起来：${r.text}` })
      return r
    },
  }
  /**
   * 送进开着的窗口:发信小进程也是一次 Claude 调用,同样过网络闸门;不登记执行占用(跑的是那个窗口)。
   * 但发信小进程本身要跑到 90 秒,要登记 busy —— 否则空闲自动重启会把它杀在半路,话就丢了(评审 10-19 #2)。
   */
  async function relayInner(s: CliSessionInfo, w: LiveWindow, text: string): Promise<ResumeOutcome> {
    if (deps.networkGate) {
      const d = await decideCall(deps.networkGate, { provider: 'claude', purpose: 'turn' as const })
      if (!d.allowed) { deps.log('CLI_REPLY', `relay ${s.session_id.slice(0, 6)} refused — network unprotected [${d.verdict!.source}]`); return { kind: 'failed', text: unprotectedMessage(d.verdict!, d.cls.label) } }
    }
    deps.log('CLI_REPLY', `relay → live window ${w.name} (pid ${w.pid}) for claude/${s.session_id.slice(0, 6)}`)
    const release = deps.holdBusy?.(`cli-relay:${s.session_id.slice(0, 6)}`) ?? (() => {})
    // 同一条会话连着说两句:发信小进程排队,一句送完再送下一句 —— 并行跑时谁先到不一定(评审 10-19 #8)。
    const prev = relayChains.get(s.session_id) ?? Promise.resolve()
    const mine = prev.then(() => deps.liveWindow!.relay(w, text))
      .catch(err => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }))
      .finally(release)
    relayChains.set(s.session_id, mine)
    void mine.finally(() => { if (relayChains.get(s.session_id) === mine) relayChains.delete(s.session_id) })
    const r = await mine
    if (!r.ok) { deps.log('CLI_REPLY', `relay ${s.session_id.slice(0, 6)} failed: ${r.error}`); return { kind: 'failed', text: `没送进电脑上开着的窗口(${r.error})` } }
    return { kind: 'relayed', text: w.name }
  }
  async function resumeInner(s: CliSessionInfo, text: string): Promise<ResumeOutcome> {
    // 守护 v2:按这条终端会话的来源分类(claude 看 ANTHROPIC_BASE_URL;codex 看它自己的配置层 ——
    // CODEX_HOME/config.toml + 这个目录的项目层,codex 不认 OPENAI_BASE_URL);需要保护且网络不安全才不起 CLI。
    if (deps.networkGate) {
      // cursor:接着跑的是那条会话自己选的模型,登记处里没有 —— 不猜,按 unresolved(需要保护)走,
      // 网络安全时照常放行,不安全时宁可不起(Cursor 只有 auto 才免保护)。
      const target = s.source === 'codex'
        ? codexCallTarget({ model: null, purpose: 'turn' }, { env: process.env, cwd: s.cwd })
        : s.source === 'cursor'
          ? { provider: 'cursor', purpose: 'turn' as const, unresolved: true }
          : { provider: s.source, purpose: 'turn' as const }
      const d = await decideCall(deps.networkGate, target)
      if (!d.allowed) { deps.log('CLI_REPLY', `resume ${s.source}/${s.session_id.slice(0, 6)} refused — network unprotected [${d.verdict!.source}]`); return { kind: 'failed', text: unprotectedMessage(d.verdict!, d.cls.label) } }
    }
    if(deps.executionConflict?.(s))return{kind:'failed',text:'这条会话或文件夹正在「一起做」里，请在那里继续。'}
    let settle:((closed:boolean)=>void)|undefined,closed=false
    try{settle=deps.reserveExecution?.(s)}catch{return{kind:'failed',text:'这个文件夹有另一项任务正在执行，请稍后再试。'}}
    const { cmd, args } = resumeCommand(s.source, s.session_id, text, deps.dangerously, deps.claudeBin ? { claude: deps.claudeBin } : {})
    const release = deps.holdBusy?.(`cli-resume:${s.session_id.slice(0, 6)}`) ?? (() => {})
    let cwd = s.cwd
    if (s.source === 'claude' && deps.startCwd) { try { cwd = deps.startCwd(s) ?? s.cwd } catch { cwd = s.cwd } }
    try {
      deps.log('CLI_REPLY', `resume ${s.source}/${s.session_id.slice(0, 6)} in ${cwd}`)
      const r = await run(cmd, args, cwd, RESUME_TIMEOUT_MS)
      closed=r.closed===true
      const out = r.stdout.trim()
      if (r.timedOut) return { kind: 'timeout', text: out }
      if (r.code !== 0 && !out) return { kind: 'failed', text: `${r.stderr.trim().split('\n')[0]?.trim().slice(0, 200) || '没有错误输出'}` }
      return { kind: 'ok', text: out || '(没有输出)' }
    } catch (err) {
      return { kind: 'failed', text: err instanceof Error ? err.message : String(err) }
    } finally { release();settle?.(closed) }
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
    const label = `${cliSourceLabel(s.source)} · 码 ${s.session_id.slice(0, 6)}`
    if (req.kind === 'view') {
      const v = core.viewMarkdown(s, label)
      return v.ok ? { ok: true, markdown: v.markdown } : { ok: false, error: v.error }
    }
    if (!req.text) return { ok: false, error: 'text_required' }
    void core.resume(s, req.text).then(async (r) => {
      const plain = stripMarkdown(r.text).slice(0, INLINE_MAX)
      const msg = r.kind === 'relayed' ? `${label} 开在电脑的窗口里,话已经送进去了;它做完会照常报。`
        : r.kind === 'ok' ? `${label} 回来了\n${plain}`
        : r.kind === 'timeout' ? `${label} 跑了 ${Math.round(RESUME_TIMEOUT_MS / 60_000)} 分钟还没完,先停了。${plain ? `\n目前的输出:\n${plain}` : ''}`
        : `${label} 没跑起来：${plain}`
      await deps.notifyBrain(msg).catch(err => deps.log('CLI_REPLY', `notify brain failed: ${err instanceof Error ? err.message : String(err)}`))
    })
    return { ok: true }
  }
}

/** 只读文件开头(找会话起点的 cwd)。 */
export function readHead(path: string, max: number): string {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(max)
    const n = readSync(fd, buf, 0, max, 0)
    return buf.subarray(0, n).toString('utf8')
  } finally { closeSync(fd) }
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
  /** 只读:主人发的「终端」「看 码」「@码 文本」。 */
  probe(text: string, chatId: string): boolean
  /** true = 这句话是给终端会话的,已处理(或已回绝);false = 不是,交给后面的中间件。 */
  handle(text: string, chatId: string): Promise<boolean>
}

export function makeCliReplyHandler(deps: CliReplyHandlerDeps): CliReplyHandler {
  const core = makeCliReplyCore(deps)
  const say = (chatId: string, text: string) => deps.sendMessage(chatId, text).catch(err => deps.log('CLI_REPLY', `send failed: ${err instanceof Error ? err.message : String(err)}`))

  function describe(s: CliSessionInfo): string {
    return `${cliSourceLabel(s.source)} · 码 ${s.session_id.slice(0, 6)}${s.machine && deps.localMachine && s.machine !== deps.localMachine ? ` · 那边(${s.machine})` : ''}`
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

  async function list(chatId: string): Promise<void> {
    let views: CliDigestView[]
    try { views = deps.listSessions!() }
    catch (err) {
      deps.log('CLI_REPLY', `list failed: ${err instanceof Error ? err.message : String(err)}`)
      await say(chatId, '现在读不到终端会话的登记,稍后再试。')
      return
    }
    await say(chatId, formatCliSessionDigest(views, { now: (deps.now ?? Date.now)(), localMachine: deps.localMachine }))
  }

  async function today(chatId: string): Promise<void> {
    let text: string
    try { text = formatOverseerToday(deps.today!(), { now: (deps.now ?? Date.now)() }) }
    catch (err) {
      deps.log('CLI_REPLY', `today failed: ${err instanceof Error ? err.message : String(err)}`)
      text = '现在读不到今天的情况,稍后再试。'
    }
    await say(chatId, text)
  }

  async function view(chatId: string, code: string): Promise<void> {
    const s = deps.hub.lookup(code)
    if (!s) { await say(chatId, notFound(code)); return }
    if (isRemote(s)) {
      if (!deps.remote) { await say(chatId, `${describe(s)} 在别的机器上,这台机接不上它。`); return }
      const r = await deps.remote.view(s).catch(err => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }))
      if (!r.ok) { await say(chatId, r.error === 'session_unknown' ? `${describe(s)}:那台机器上找不到这条会话了。` : `${describe(s)}:那边看不了(${r.error})。`); return }
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
    // 开在电脑的窗口里:话送进窗口(它在跑也行,下一步就读到),不起副本。
    if (core.live(s)) {
      await say(chatId, `收到,${describe(s)} 开在电脑的窗口里,这就把话送进去…`)
      void core.resume(s, text).then(async (r) => {
        await say(chatId, r.kind === 'relayed' ? `${describe(s)}:已送进窗口「${r.text}」,它做完会照常推给你。` : `${describe(s)} ${r.text}`)
      })
      return
    }
    // 终端那头这一轮还没完(在跑 / 等批准 / 30 分钟没动静可能是长构建):再起 resume 会和它抢同一条会话(评审 10-15 #2)。
    let v: CliDigestView | undefined
    try { v = deps.listSessions?.().find(x => x.session_id === s.session_id) } catch { v = undefined }
    if (v && (v.status === 'running' || v.status === 'waiting' || v.stale)) {
      await say(chatId, `${describe(s)} 终端那边这一轮还没完,等它停下再「@码」接着说。`)
      return
    }
    await say(chatId, `收到,${describe(s)} 接着跑…(最多等 ${Math.round(RESUME_TIMEOUT_MS / 60_000)} 分钟)`)
    void core.resume(s, text).then(async (r) => {
      if (r.kind === 'timeout') { await say(chatId, `${describe(s)} 跑了 ${Math.round(RESUME_TIMEOUT_MS / 60_000)} 分钟还没完,先停了。${r.text ? `\n目前的输出:\n${stripMarkdown(r.text).slice(0, INLINE_MAX)}` : ''}`); return }
      if (r.kind === 'failed') { await say(chatId, `${describe(s)} 没跑起来：${r.text}`); return }
      if (r.kind === 'relayed') { await say(chatId, `${describe(s)}:已送进窗口「${r.text}」,它做完会照常推给你。`); return }
      const plain = stripMarkdown(r.text)
      if (plain.length > INLINE_MAX) {
        const url = await deps.sharePage(`${describe(s)} 的回复`, r.text, chatId).catch(() => null)
        await say(chatId, `${describe(s)} 回来了\n${plain.slice(0, INLINE_MAX - 1)}…${url ? `\n全文:${url}` : ''}`)
      } else {
        await say(chatId, `${describe(s)} 回来了\n${plain}`)
      }
    })
  }

  /** 「终端」「日报」要有数据源才认;没接 ⇒ 当普通消息交给后面。 */
  const supported = (p: NonNullable<ReturnType<typeof parseCliReply>>): boolean =>
    p.kind === 'list' ? !!deps.listSessions : p.kind === 'today' ? !!deps.today : true

  return {
    probe(text, chatId) {
      const parsed = parseCliReply(text)
      if (!parsed || !supported(parsed)) return false
      return deps.isOwner(chatId)
    },
    async handle(text, chatId) {
      const parsed = parseCliReply(text)
      if (!parsed || !supported(parsed)) return false
      if (!deps.isOwner(chatId)) return false   // 不是主人:当普通消息,别暴露会话码这套
      if (parsed.kind === 'list') await list(chatId)
      else if (parsed.kind === 'today') await today(chatId)
      else if (parsed.kind === 'view') await view(chatId, parsed.code)
      else await sayTo(chatId, parsed.code, parsed.text)
      return true
    },
  }
}
