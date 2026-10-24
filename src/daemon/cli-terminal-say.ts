/**
 * cli-terminal-say.ts — CC 自己代主人对一条终端会话说一句、等它回话(terminal_say,2026-10-24)。
 *
 * 为什么:主人在外面跟 CC 说「跟终端里正在开发 cc 的 Claude 讨论一下这个」「让 6ccb0f 先停下改 X」——
 * 「不然怎么远程指挥呢?」(主人 10-24)。那天 CC 只有 delegate_claude,起的是一个**新的** Claude,
 * 不是终端里干活的那个;主人自己能敲「@码 话」,模型没有工具。
 *
 * 不另起投递:送话走主人「@码」同一个 makeCliReplyCore(开着窗口 ⇒ 送进窗口;不开着 ⇒ resume),
 * 同样的网络闸门、工作台冲突检查(executionConflict / reserveExecution)、busy 登记。这里只多两件事:
 * - 第一行标明是 CC 代主人转来的、回复会转回去(TERMINAL_SAY_HEADER);
 * - 记一张票,等**这条会话**的回话:窗口那条路等它自己 hooks 报来的下一个 Stop(last_assistant_message,
 *   与「终端会话完成推送」同一个事件);resume 那条路就是 resume 进程的输出。
 *
 * 等的期间持一个 busy 令牌(登记处规矩:后台长任务必须持 holdBusy),空闲自动重启不会掐在半路;
 * 到点没等到就放掉,票留一阵子,回头还能问。
 *
 * 只说事实:被拒时回登记处里的原状态(running / waiting / stale / ended),不说「它很忙」。
 */
import { randomBytes } from 'node:crypto'
import type { CliEvent, CliSessionInfo, CliSource } from '../core/cli-events'
import type { CliSessionView } from '../core/cli-session-store'
import { redactSecrets } from '../core/cli-transcript'
import type { CliReplyCore } from './cli-reply-handler'

/** 一句最多这么长(同手机说一句 PHONE_CLI_SAY_MAX)。 */
export const TERMINAL_SAY_MAX_TEXT = 4000
/** 工具缺省等多久、最多等多久(秒)。 */
export const TERMINAL_SAY_WAIT_DEFAULT_S = 240
export const TERMINAL_SAY_WAIT_MAX_S = 600
/** 一次 GET 最多挂这么久再回(同 CLI_PERMISSION_POLL_CAP_MS):工具那头自己循环,一个 HTTP 请求不挂十分钟。 */
export const TERMINAL_SAY_POLL_CAP_MS = 25_000
/** 等回话那段时间持 busy 的上限:最长的等待 + 窗口发信小进程的 90 秒 + 余量。之后没人在等了。 */
export const TERMINAL_SAY_BUSY_MAX_MS = (TERMINAL_SAY_WAIT_MAX_S + 120) * 1000
/** 票留多久(超时之后回头再问还查得到)、最多留几张。 */
const TICKET_TTL_MS = 30 * 60_000
/** 两次轮询之间的空隙在这之内都算「还有人在等」。 */
const WAITER_GAP_MS = 10_000
const MAX_TICKETS = 64
/** 回给模型的回复最长这么多字(Stop 事件本身封顶 4000;resume 的输出可能很长)。 */
export const TERMINAL_SAY_REPLY_MAX = 8000

/**
 * 对方读到的第一行。不是主人原话 ⇒ 写明是 CC 转述;回复会被转回去 ⇒ 对方知道最后那段话是写给主人看的。
 * 窗口那条路它是 relayMessage 的第一行,resume 那条路它在话前面一行:两边看到的样子一样。
 */
export const TERMINAL_SAY_HEADER = '(Tendhearth CC 代主人转来,不是主人原话;你这一轮最后的回复会由 CC 转回给主人)'

export type TerminalSayVia = 'window' | 'resume'
/**
 * sending:正往开着的窗口送;delivered:送进窗口了,等它这一轮的 Stop;running:resume 在跑;
 * replied:有回话;failed:没送到 / 没跑起来;ended:送到之后会话结束了、没回话;timeout:resume 跑满 10 分钟被停。
 */
export type TerminalSayState = 'sending' | 'delivered' | 'running' | 'replied' | 'failed' | 'ended' | 'timeout'
const FINAL: ReadonlySet<TerminalSayState> = new Set(['replied', 'failed', 'ended', 'timeout'])

export type TerminalSayError =
  | 'terminal_say_unknown_session'
  | 'terminal_say_remote'
  | 'terminal_say_ended'
  | 'terminal_say_turn_open'
  | 'terminal_say_pending'

export type TerminalSayStart =
  | { ok: true; ticket: string; via: TerminalSayVia; code: string; source: CliSource; project: string; was_running: boolean }
  | { ok: false; error: TerminalSayError; code?: string; status?: string; detail: string }

export interface TerminalSayView {
  ticket: string
  code: string
  source: CliSource
  project: string
  via: TerminalSayVia
  state: TerminalSayState
  final: boolean
  /** true = 送到了;false = 没送到;null = 还不知道(正在送)。 */
  delivered: boolean | null
  reply: string | null
  reply_truncated: boolean
  error: string | null
  elapsed_ms: number
  /** 送到时它正在跑上一轮 ⇒ 收到的这段回话可能是那一轮的收尾。 */
  was_running: boolean
}

export interface TerminalSay {
  say(code: string, text: string): TerminalSayStart
  /** 等到有结果或 waitMs 到点;票不存在 ⇒ null。 */
  wait(ticket: string, waitMs: number): Promise<TerminalSayView | null>
  view(ticket: string): TerminalSayView | null
  /**
   * 终端 hooks 报来的事件(POST /v1/cli/event 那一口)—— 窗口那条路靠它拿到回话。
   * 回 true = 这是 CC 此刻正等着的回话(有工具调用在等),CC 会转给主人 ⇒ 调用方不再照常推「做完了」。
   */
  noteEvent(ev: CliEvent): boolean
  dispose(): void
}

export interface TerminalSayDeps {
  hub: { lookup(code: string): CliSessionInfo | null; list(opts?: { includeEnded?: boolean; limit?: number }): CliSessionView[] }
  core: Pick<CliReplyCore, 'resume' | 'live'>
  holdBusy?: (label: string) => () => void
  localMachine?: string
  log: (tag: string, line: string) => void
  now?: () => number
}

interface Ticket {
  id: string
  sessionId: string
  code: string
  source: CliSource
  project: string
  via: TerminalSayVia
  state: TerminalSayState
  delivered: boolean | null
  reply: string | null
  truncated: boolean
  error: string | null
  startedAt: number
  settledAt: number | null
  wasRunning: boolean
  /** 窗口那条路:还在送的时候就来了 Stop(对方答得快 / 或是上一轮的收尾),送完再判归属。 */
  earlyStop: string | null
  waiters: Set<() => void>
  /** 上一次有人来等(GET 轮询之间有空隙:刚回、下一次还没到时 waiters 是空的)。 */
  lastWaitAt: number
  release: () => void
  busyTimer: ReturnType<typeof setTimeout> | null
}

export function makeTerminalSay(deps: TerminalSayDeps): TerminalSay {
  const now = deps.now ?? (() => Date.now())
  const tickets = new Map<string, Ticket>()

  const toView = (t: Ticket): TerminalSayView => ({
    ticket: t.id, code: t.code, source: t.source, project: t.project, via: t.via, state: t.state, final: FINAL.has(t.state),
    delivered: t.delivered, reply: t.reply, reply_truncated: t.truncated, error: t.error,
    elapsed_ms: (t.settledAt ?? now()) - t.startedAt, was_running: t.wasRunning,
  })

  const wake = (t: Ticket) => { for (const w of [...t.waiters]) w() }
  const releaseBusy = (t: Ticket) => {
    if (t.busyTimer) { clearTimeout(t.busyTimer); t.busyTimer = null }
    const r = t.release; t.release = () => {}; r()
  }
  const settle = (t: Ticket, patch: Partial<Pick<Ticket, 'state' | 'delivered' | 'reply' | 'error'>>) => {
    if (FINAL.has(t.state)) return
    Object.assign(t, patch)
    if (patch.reply != null) {
      const clean = redactSecrets(patch.reply)
      t.truncated = clean.length > TERMINAL_SAY_REPLY_MAX
      t.reply = t.truncated ? clean.slice(0, TERMINAL_SAY_REPLY_MAX) : clean
    }
    if (FINAL.has(t.state)) { t.settledAt = now(); releaseBusy(t) }
    wake(t)
  }

  const prune = () => {
    const cut = now() - TICKET_TTL_MS
    // 等不到回话的票(窗口那一轮一直没 Stop)也不永远留着
    for (const [id, t] of tickets) if ((t.settledAt ?? t.startedAt) < cut) { releaseBusy(t); tickets.delete(id) }
    while (tickets.size > MAX_TICKETS) {
      const oldest = [...tickets.values()].find(t => t.settledAt !== null) ?? tickets.values().next().value!
      releaseBusy(oldest); tickets.delete(oldest.id)
    }
  }

  const isRemote = (s: CliSessionInfo) => !!s.origin_agent || (!!s.machine && !!deps.localMachine && s.machine !== deps.localMachine)
  // 还在等的上一句只挡 TERMINAL_SAY_BUSY_MAX_MS:窗口那一轮一直不 Stop 也不能把这条会话永远堵死。迟到的 Stop 照样记进那张票。
  const openFor = (sessionId: string) => [...tickets.values()].find(t => t.sessionId === sessionId && !FINAL.has(t.state) && now() - t.startedAt < TERMINAL_SAY_BUSY_MAX_MS) ?? null

  return {
    say(code, text) {
      prune()
      const s = deps.hub.lookup(code)
      if (!s) {
        const recent = deps.hub.list({ limit: 5 }).map(v => `${v.code}(${v.source})`)
        return { ok: false, error: 'terminal_say_unknown_session', code, detail: `没见过会话码「${code}」(或那条会话已经结束)。${recent.length ? `最近的:${recent.join('、')}` : '还没有终端会话报到过。'}` }
      }
      const short = s.session_id.slice(0, 6)
      // 那边(别的机器)的会话:主人「@码」会转给那只手,可那只手的回话是异步发回微信的,这里等不到 —— v1 不接。
      if (isRemote(s)) return { ok: false, error: 'terminal_say_remote', code: short, detail: `码 ${short} 在别的机器${s.machine ? `(${s.machine})` : ''}上,CC 现在只能跟这台电脑上的会话说话;主人可以自己发「@${short} 话」转过去。` }
      // 同一条会话上一句还在等:Stop 归谁就说不清了 —— 一次一句。
      const open = openFor(s.session_id)
      if (open) return { ok: false, error: 'terminal_say_pending', code: short, detail: `上一句(票 ${open.id})还在等码 ${short} 回话;等它回了再说下一句,或用 terminal_say_result 再看一次。` }
      let v: CliSessionView | undefined
      try { v = deps.hub.list({ includeEnded: true, limit: 500 }).find(x => x.session_id === s.session_id) } catch { v = undefined }
      const project = v?.project ?? s.cwd.split(/[\\/]/).filter(Boolean).pop() ?? s.cwd
      const w = deps.core.live(s)
      // 不开着窗口:跟主人「@码」同一条判法 —— 终端那头这一轮还没完就不起 resume(会抢同一条会话,评审 10-15 #2)。
      if (!w) {
        if (v?.status === 'ended') return { ok: false, error: 'terminal_say_ended', code: short, status: 'ended', detail: `码 ${short} 已经结束,窗口也没开着。` }
        if (v && (v.status === 'running' || v.status === 'waiting' || v.stale)) {
          const status = v.stale ? 'stale' : v.status
          const what = status === 'waiting' ? '在等主人批准一项操作' : status === 'running' ? '这一轮还在跑' : '30 分钟没报过动静(可能在跑一步很长的命令,也可能停住了)'
          return { ok: false, error: 'terminal_say_turn_open', code: short, status, detail: `码 ${short} 没开在电脑窗口里,登记处显示它${what}。现在接着说会和它那一轮抢同一条会话,所以没送。等它停下再说。` }
        }
      }
      const id = randomBytes(6).toString('hex')
      const via: TerminalSayVia = w ? 'window' : 'resume'
      const t: Ticket = {
        id, sessionId: s.session_id, code: short, source: s.source, project, via,
        state: w ? 'sending' : 'running', delivered: w ? null : true, reply: null, truncated: false, error: null,
        startedAt: now(), settledAt: null, wasRunning: !!w && (v?.status === 'running' || v?.status === 'waiting'), earlyStop: null,
        waiters: new Set(), lastWaitAt: now(), release: deps.holdBusy?.(`terminal-say:${short}`) ?? (() => {}), busyTimer: null,
      }
      t.busyTimer = setTimeout(() => releaseBusy(t), TERMINAL_SAY_BUSY_MAX_MS)
      ;(t.busyTimer as { unref?: () => void }).unref?.()
      tickets.set(id, t)
      deps.log('TERMINAL_SAY', `${id} → ${s.source}/${short} via ${via}${t.wasRunning ? ' (was running)' : ''}`)
      void deps.core.resume(s, text, { header: TERMINAL_SAY_HEADER }).then((r) => {
        if (r.kind === 'failed') { settle(t, { state: 'failed', delivered: false, error: r.text }); return }
        if (r.kind === 'relayed') {
          if (FINAL.has(t.state)) return
          t.state = 'delivered'; t.delivered = true
          // 送的那段时间里已经来了 Stop:它本来歇着 ⇒ 那就是对这句的回话(答得比发信小进程退出还快);
          // 它本来在跑 ⇒ 多半是上一轮的收尾,丢掉、等下一个。
          if (t.earlyStop !== null && !t.wasRunning) settle(t, { state: 'replied', reply: t.earlyStop })
          else wake(t)
          return
        }
        if (r.kind === 'timeout') { settle(t, { state: 'timeout', ...(r.text ? { reply: r.text } : {}) }); return }
        settle(t, { state: 'replied', reply: r.text })
      }, (err) => settle(t, { state: 'failed', delivered: false, error: err instanceof Error ? err.message : String(err) }))
      return { ok: true, ticket: id, via, code: short, source: s.source, project, was_running: t.wasRunning }
    },

    async wait(ticket, waitMs) {
      const t = tickets.get(ticket)
      if (!t) return null
      t.lastWaitAt = now()
      if (FINAL.has(t.state) || waitMs <= 0) return toView(t)
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer); t.waiters.delete(done); t.lastWaitAt = now(); resolve() }
        const timer = setTimeout(done, waitMs)
        t.waiters.add(done)
      })
      return toView(t)
    },

    view(ticket) { const t = tickets.get(ticket); return t ? toView(t) : null },

    noteEvent(ev) {
      if (ev.kind !== 'stop' && ev.kind !== 'session_end') return false
      let handed = false
      for (const t of tickets.values()) {
        if (t.via !== 'window' || t.sessionId !== ev.session_id || FINAL.has(t.state)) continue
        if (ev.kind === 'session_end') { settle(t, { state: 'ended' }); continue }
        const text = ev.text ?? ''
        // 还在送:先记下,送完再判归属(见 say);这时不算「交给 CC 了」,照常推
        if (t.state === 'sending') { t.earlyStop = text; continue }
        if (t.waiters.size > 0 || now() - t.lastWaitAt < WAITER_GAP_MS) handed = true
        settle(t, { state: 'replied', reply: text })
      }
      return handed
    },

    dispose() {
      for (const t of tickets.values()) { releaseBusy(t); wake(t) }
      tickets.clear()
    },
  }
}
