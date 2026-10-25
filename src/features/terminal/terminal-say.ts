/**
 * terminal-say.ts — CC 自己代主人对一条终端会话说一句、等它回话(terminal_say,2026-10-24)。
 *
 * 为什么:主人在外面跟 CC 说「跟终端里正在开发 cc 的 Claude 讨论一下这个」「让 6ccb0f 先停下改 X」——
 * 「不然怎么远程指挥呢?」(主人 10-24)。那天 CC 只有 delegate_claude,起的是一个**新的** Claude,
 * 不是终端里干活的那个;主人自己能敲「@码 话」,模型没有工具。
 *
 * 不另起投递:送话走主人「@码」同一个 makeCliReplyCore(开着窗口 ⇒ 送进窗口;不开着 ⇒ resume),
 * 同样的网络闸门、工作台冲突检查(executionConflict / reserveExecution)、busy 登记。这里多的是:
 * - 第一行标明是 CC 代主人转来的、回复会转回去(TERMINAL_SAY_HEADER);
 * - resume 那条路**不带** daemon 的免审姿态(评审 #662-3,主人那边的整合者定的):话是模型写的,不能拿
 *   --dangerously-skip-permissions / --force / bypass-approvals 去跑。没开着窗口时是只读续接 —— 要权限的
 *   工具会被拒,会话照样能读、能答(「讨论」够用);要它真动手改,请主人自己「@码」。窗口那条路不变:
 *   那个窗口有主人给它的权限;
 * - 记一张票,等**这条会话**的回话:窗口那条路等它自己 hooks 报来的下一个 Stop(last_assistant_message,
 *   与「终端会话完成推送」同一个事件);resume 那条路就是 resume 进程的输出。
 *
 * 回话不能丢、也不能被吞(评审 #662-1 / #662-2):
 * - 「有人在等」只算**此刻连着的、会把这份回话带回去的那一次轮询**(wait 带了 >0 的等待、HTTP 没断)。
 *   只看一眼(wait 0)不算;两次轮询之间的空隙不算;MCP 子进程死了、请求断开就立刻不算。
 * - Stop 来时有人在等 ⇒ 交给那次轮询带回去,调用方不再照常推「做完了」;别的情况一律照常推。
 * - 票到了终局却没人领(没有连着的轮询、之后几秒也没人来看)⇒ 自己告诉主人,措辞同「@码」那条路
 *   (resume 的结果 / 没送到)。窗口那条路的回话不用另发:那时 Stop 没被吞,hub 已经照常推了。
 *
 * 等的期间持一个 busy 令牌(登记处规矩:后台长任务必须持 holdBusy),空闲自动重启不会掐在半路。
 *
 * 只说事实:被拒时回登记处里的原状态(running / waiting / stale / ended),不说「它很忙」。
 *
 * 伪造回话(评审 #662-4):POST /v1/cli/event 是 trusted 档(hook 子命令拿的是 daemon 的 file 令牌),
 * 本机任何拿得到那个令牌的进程都能报一个 Stop。这里能做的:事件的 source / machine / transcript_path 要和
 * 送话时登记处里那条会话对得上;再读那条会话自己的记录尾巴,最后一句和事件里的话对得上 ⇒ reply_verified=true,
 * 对不上 / 读不到 ⇒ false(照样带回,工具结果里照实说没核对上)。分不出事件是不是 hook 发的(同一个令牌、同一条路由);
 * 拿得到 file 令牌的本来就是主人这台机上的进程,剩下的口子在这一层。
 */
import { randomBytes } from 'node:crypto'
import { stripMarkdown, INLINE_MAX, type CliEvent, type CliSessionInfo, type CliSource } from '../../core/cli-events'
import type { CliSessionView } from '../../adapters/store/cli-session-store'
import { cliSourceLabel } from '../../domain/cli-session-digest'
import { lastAssistantText, redactSecrets } from '../../core/cli-transcript'
import { RESUME_TIMEOUT_MS, type CliReplyCore } from './reply-handler'

/** 一句最多这么长(同手机说一句 PHONE_CLI_SAY_MAX)。 */
export const TERMINAL_SAY_MAX_TEXT = 4000
/** 工具缺省等多久、最多等多久(秒)。 */
export const TERMINAL_SAY_WAIT_DEFAULT_S = 240
export const TERMINAL_SAY_WAIT_MAX_S = 600
/** 一次 GET 最多挂这么久再回(同 CLI_PERMISSION_POLL_CAP_MS):工具那头自己循环,一个 HTTP 请求不挂十分钟。 */
export const TERMINAL_SAY_POLL_CAP_MS = 25_000
/** 等回话那段时间持 busy 的上限:resume 最长 10 分钟 + 窗口发信小进程的 90 秒 + 余量。 */
export const TERMINAL_SAY_BUSY_MAX_MS = RESUME_TIMEOUT_MS + 120_000
/** 到了终局、此刻没人在等:再给这么久让工具的下一次轮询来领(轮询之间有空隙),没人领才告诉主人。 */
export const TERMINAL_SAY_UNCLAIMED_GRACE_MS = 5_000
/** CC 自己这一轮的看门狗之前留这么多(工具调用期间 provider 一个事件都不发)。 */
const TURN_WATCHDOG_MARGIN_MS = 30_000
/** 票留多久(超时之后回头再问还查得到)、最多留几张。 */
const TICKET_TTL_MS = 30 * 60_000
const MAX_TICKETS = 64
/** 回给模型的回复最长这么多字(Stop 事件本身封顶 4000;resume 的输出可能很长)。 */
export const TERMINAL_SAY_REPLY_MAX = 8000

/**
 * 工具一次最多等多久(毫秒):CC 这一轮的看门狗(turnTimeoutMs,collectTurn「多久没事件就判卡死」)减一段余量,
 * 不超过 TERMINAL_SAY_WAIT_MAX_S。看门狗关着(0)⇒ 就是上限。真等满看门狗,整轮被丢、回话也丢。
 */
export function terminalSayMaxWaitMs(turnTimeoutMs: number): number {
  const cap = TERMINAL_SAY_WAIT_MAX_S * 1000
  if (!(turnTimeoutMs > 0)) return cap
  return Math.max(0, Math.min(cap, turnTimeoutMs - TURN_WATCHDOG_MARGIN_MS))
}

/**
 * 对方读到的第一行。不是主人原话 ⇒ 写明是 CC 转述;回复会被转回去 ⇒ 对方知道最后那段话是写给主人看的。
 * 窗口那条路它是 relayMessage 的第一行,resume 那条路它在话前面一行:两边看到的样子一样。
 */
export const TERMINAL_SAY_HEADER = '(Tendhearth CC 代主人转来,不是主人原话;你这一轮最后的回复会由 CC 转回给主人)'

export type TerminalSayVia = 'window' | 'resume'
/**
 * sending:正往开着的窗口送;delivered:送进窗口了,等它这一轮的 Stop;running:resume 在跑;
 * replied:有回话;failed:没送到 / 没跑起来;ended:送到之后会话结束了、没回话;timeout:resume 跑满 10 分钟被停;
 * expired:窗口那一轮一直没 Stop,超过 TERMINAL_SAY_BUSY_MAX_MS 后主人 / CC 又说了下一句,这张票先收掉。
 */
export type TerminalSayState = 'sending' | 'delivered' | 'running' | 'replied' | 'failed' | 'ended' | 'timeout' | 'expired'
const FINAL: ReadonlySet<TerminalSayState> = new Set(['replied', 'failed', 'ended', 'timeout', 'expired'])

export type TerminalSayError =
  | 'terminal_say_unknown_session'
  | 'terminal_say_remote'
  | 'terminal_say_ended'
  | 'terminal_say_turn_open'
  | 'terminal_say_pending'

export type TerminalSayStart =
  | { ok: true; ticket: string; via: TerminalSayVia; code: string; source: CliSource; project: string; was_running: boolean; read_only: boolean; max_wait_ms: number }
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
  /** 窗口那条路:回话和那条会话自己的记录对上了吗(null = resume 那条路,回话就是进程输出,不用核)。 */
  reply_verified: boolean | null
  error: string | null
  elapsed_ms: number
  /** 送到时它正在跑上一轮 ⇒ 收到的这段回话可能是那一轮的收尾。 */
  was_running: boolean
  /** resume 那条路不带免审:要权限的工具会被拒。 */
  read_only: boolean
  /** 没人领、已经由 daemon 自己告诉主人了(之后不用 CC 再转)。 */
  owner_notified: boolean
  /** 主人已经收到这条回复了(daemon 告诉过,或这条 Stop 照常排了终端完成推送)⇒ CC 别再转述(评审 #662 二轮 #3)。 */
  owner_has_reply: boolean
  /** 工具一次最多等多久(terminalSayMaxWaitMs)。 */
  max_wait_ms: number
}

export interface TerminalSay {
  say(code: string, text: string): TerminalSayStart
  /**
   * 等到有结果或 waitMs 到点;票不存在 ⇒ null。waitMs=0 只看一眼,不算「有人在等」。
   * signal 中止(请求断开)⇒ 立刻不算在等、马上返回。
   */
  wait(ticket: string, waitMs: number, signal?: AbortSignal): Promise<TerminalSayView | null>
  view(ticket: string): TerminalSayView | null
  /** 这张票的终局已经写给调用方了(GET 回包 'finish' 之后才调)⇒ 不用 daemon 再告诉主人。 */
  claim(ticket: string): void
  /** 这条会话刚报来的 Stop 照常排了终端完成推送(hub ingest 回 scheduled)⇒ 主人会收到那一句。 */
  markPushed(sessionId: string): void
  /**
   * 终端 hooks 报来的事件(POST /v1/cli/event 那一口)—— 窗口那条路靠它拿到回话。
   * 回 true = 此刻有一次连着的轮询会把这份回话带回去 ⇒ 调用方不再照常推「做完了」;其余一律 false,照常推。
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
  /** 没人领的终局告诉主人(daemon 经 CC 开口那道门发微信)。缺席 ⇒ 只记日志。 */
  notifyOwner?: (text: string) => Promise<unknown> | unknown
  /** 超长的回话:全文进页面,微信里放前一段 + 链接(同「@码」)。 */
  sharePage?: (title: string, markdown: string) => Promise<string | null>
  /** 读那条会话的记录尾巴(核对窗口那条路的回话)。缺席 / 读不到 ⇒ 不核对(reply_verified=false)。 */
  readTranscript?: (path: string) => string
  /** CC 这一轮的看门狗(turnTimeoutMs);缺席 ⇒ 按 10 分钟算。 */
  turnTimeoutMs?: number
  /** 测试用:终局没人领时等多久再告诉主人;缺省 TERMINAL_SAY_UNCLAIMED_GRACE_MS。 */
  unclaimedGraceMs?: number
  now?: () => number
}

interface Ticket {
  id: string
  sessionId: string
  code: string
  source: CliSource
  machine: string | undefined
  transcriptPath: string | undefined
  project: string
  via: TerminalSayVia
  state: TerminalSayState
  delivered: boolean | null
  reply: string | null
  truncated: boolean
  verified: boolean | null
  error: string | null
  startedAt: number
  settledAt: number | null
  wasRunning: boolean
  /** 窗口那条路:还在送的时候就来了 Stop(对方答得快 / 或是上一轮的收尾),送完再判归属。 */
  earlyStop: CliEvent | null
  /** 此刻连着的、等待 >0 的轮询。 */
  waiters: Set<() => void>
  /** 终局之后有人看到过(哪怕只看一眼)⇒ 不用 daemon 再告诉主人。 */
  claimed: boolean
  ownerNotified: boolean
  /** 上一个没被吞的 Stop 的话(调用方随后照常推);markPushed 之后进 pushedText。 */
  unhandedText: string | null
  pushedText: string | null
  release: () => void
  busyTimer: ReturnType<typeof setTimeout> | null
  claimTimer: ReturnType<typeof setTimeout> | null
}

const unref = (t: ReturnType<typeof setTimeout>) => { (t as { unref?: () => void }).unref?.() }

export function makeTerminalSay(deps: TerminalSayDeps): TerminalSay {
  const now = deps.now ?? (() => Date.now())
  const tickets = new Map<string, Ticket>()
  const maxWaitMs = terminalSayMaxWaitMs(deps.turnTimeoutMs ?? 10 * 60_000)

  const toView = (t: Ticket): TerminalSayView => ({
    ticket: t.id, code: t.code, source: t.source, project: t.project, via: t.via, state: t.state, final: FINAL.has(t.state),
    delivered: t.delivered, reply: t.reply, reply_truncated: t.truncated, reply_verified: t.verified, error: t.error,
    elapsed_ms: (t.settledAt ?? now()) - t.startedAt, was_running: t.wasRunning, read_only: t.via === 'resume', owner_notified: t.ownerNotified,
    owner_has_reply: ownerHasReply(t),
    max_wait_ms: maxWaitMs,
  })
  const ownerHasReply = (t: Ticket) => t.ownerNotified || (t.reply !== null && t.pushedText !== null && t.pushedText === t.reply)
  /** 这张票的终局已经写给调用方了(回包 'finish' 之后)。断开 / 没写出去的不调这里。 */
  const claim = (t: Ticket) => { if (FINAL.has(t.state)) { t.claimed = true; if (t.claimTimer) { clearTimeout(t.claimTimer); t.claimTimer = null } } }

  const wake = (t: Ticket) => { for (const w of [...t.waiters]) w() }
  const releaseBusy = (t: Ticket) => {
    if (t.busyTimer) { clearTimeout(t.busyTimer); t.busyTimer = null }
    const r = t.release; t.release = () => {}; r()
  }
  const label = (t: Ticket) => `${cliSourceLabel(t.source)} · 码 ${t.code}`

  /** 没人领的终局 ⇒ 告诉主人,措辞同「@码」那条路(reply-handler.ts sayTo)。窗口那条路的回话 / 结束不发:hub 已照常推。 */
  async function notifyUnclaimed(t: Ticket): Promise<void> {
    t.claimTimer = null
    if (t.claimed || ownerHasReply(t)) return
    // 没有回话可说的终局不打扰主人;窗口那条路的回话照常推过了就不重复(ownerHasReply),被吞了推送才由这里补
    if (t.state === 'ended' || t.state === 'expired') return
    const head = `${label(t)}(CC 替你问的那句)`
    let text: string
    if (t.state === 'failed') text = `${head}没送到:${t.error ?? '原因不明'}`
    else if (t.state === 'timeout') text = `${head}跑了 ${Math.round(RESUME_TIMEOUT_MS / 60_000)} 分钟还没完,先停了。${t.reply ? `\n目前的输出:\n${stripMarkdown(t.reply).slice(0, INLINE_MAX)}` : ''}`
    else {
      const plain = stripMarkdown(t.reply ?? '')
      if (plain.length > INLINE_MAX) {
        const url = await deps.sharePage?.(`${label(t)} 的回复`, t.reply ?? '').catch(() => null) ?? null
        text = `${head}回来了\n${plain.slice(0, INLINE_MAX - 1)}…${url ? `\n全文:${url}` : ''}`
      } else text = `${head}回来了\n${plain || '(没有输出)'}`
    }
    if (t.claimed) return
    t.ownerNotified = true
    deps.log('TERMINAL_SAY', `${t.id} unclaimed ${t.state} → owner`)
    try { await deps.notifyOwner?.(text) } catch (err) { deps.log('TERMINAL_SAY', `${t.id} notify owner failed: ${err instanceof Error ? err.message : String(err)}`) }
  }

  const settle = (t: Ticket, patch: Partial<Pick<Ticket, 'state' | 'delivered' | 'reply' | 'error' | 'verified'>>) => {
    if (FINAL.has(t.state)) return
    Object.assign(t, patch)
    if (patch.reply != null) {
      const clean = redactSecrets(patch.reply)
      t.truncated = clean.length > TERMINAL_SAY_REPLY_MAX
      t.reply = t.truncated ? clean.slice(0, TERMINAL_SAY_REPLY_MAX) : clean
    }
    // 中间状态不叫醒连着的轮询:叫醒了就是一段空隙,那时来的 Stop 就没人带回去了
    if (!FINAL.has(t.state)) return
    t.settledAt = now(); releaseBusy(t)
    // 连着的轮询这就带回去 —— 但要等它的回包真写出去(claim)才算领走;写不出去(断了 / 子进程死了)⇒ 下面的兜底照样告诉主人。
    // 此刻没人在等:给工具的下一次轮询几秒钟来领;没人领 ⇒ 告诉主人。
    wake(t)
    t.claimTimer = setTimeout(() => { void notifyUnclaimed(t) }, deps.unclaimedGraceMs ?? TERMINAL_SAY_UNCLAIMED_GRACE_MS)
    unref(t.claimTimer)
  }

  const prune = () => {
    const cut = now() - TICKET_TTL_MS
    // 等不到回话的票(窗口那一轮一直没 Stop)也不永远留着
    for (const [id, t] of tickets) if ((t.settledAt ?? t.startedAt) < cut && !t.claimTimer) { releaseBusy(t); tickets.delete(id) }
    while (tickets.size > MAX_TICKETS) {
      const oldest = [...tickets.values()].find(t => t.settledAt !== null && !t.claimTimer) ?? tickets.values().next().value!
      releaseBusy(oldest); tickets.delete(oldest.id)
    }
  }

  const isRemote = (s: CliSessionInfo) => !!s.origin_agent || (!!s.machine && !!deps.localMachine && s.machine !== deps.localMachine)
  // 同一条会话同时只有一张没终局的票:Stop 归谁才说得清。等了超过 TERMINAL_SAY_BUSY_MAX_MS 的那张先明确收成 expired
  // (窗口那一轮一直不 Stop 也不能把这条会话永远堵死),再开新的(评审 #662 二轮 #5a)。
  const openFor = (sessionId: string) => {
    for (const t of tickets.values()) {
      if (t.sessionId !== sessionId || FINAL.has(t.state)) continue
      if (now() - t.startedAt >= TERMINAL_SAY_BUSY_MAX_MS) { settle(t, { state: 'expired' }); continue }
      return t
    }
    return null
  }

  /** 这个 Stop 是不是送话时那条会话自己报的(能核的都核)。 */
  const sameSession = (t: Ticket, ev: CliEvent): boolean =>
    ev.source === t.source
    && !ev.origin_agent
    && (!ev.machine || !t.machine || ev.machine === t.machine)
    && (!ev.transcript_path || !t.transcriptPath || ev.transcript_path === t.transcriptPath)
  /** 回话和那条会话自己的记录尾巴对得上吗(Stop 时记录可能还没写完 ⇒ 对不上就是 false,不是丢掉)。 */
  const verify = (t: Ticket, text: string): boolean => {
    const path = t.transcriptPath
    if (!path || !deps.readTranscript) return false
    try {
      const last = lastAssistantText(deps.readTranscript(path), t.source)
      const norm = (x: string) => x.replace(/\s+/g, ' ').trim()
      return !!last && norm(last) === norm(text)
    } catch { return false }
  }

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
        id, sessionId: s.session_id, code: short, source: s.source, machine: s.machine, transcriptPath: s.transcript_path, project, via,
        state: w ? 'sending' : 'running', delivered: w ? null : true, reply: null, truncated: false, verified: null, error: null,
        startedAt: now(), settledAt: null, wasRunning: !!w && (v?.status === 'running' || v?.status === 'waiting'), earlyStop: null,
        waiters: new Set(), claimed: false, ownerNotified: false, unhandedText: null, pushedText: null,
        release: deps.holdBusy?.(`terminal-say:${short}`) ?? (() => {}), busyTimer: null, claimTimer: null,
      }
      t.busyTimer = setTimeout(() => releaseBusy(t), TERMINAL_SAY_BUSY_MAX_MS)
      unref(t.busyTimer)
      tickets.set(id, t)
      deps.log('TERMINAL_SAY', `${id} → ${s.source}/${short} via ${via}${t.wasRunning ? ' (was running)' : ''}`)
      // noBypass:resume 那条路不带 daemon 的免审姿态(话是模型写的)。窗口那条路不受影响。
      void deps.core.resume(s, text, { header: TERMINAL_SAY_HEADER, noBypass: true }).then((r) => {
        if (r.kind === 'failed') { settle(t, { state: 'failed', delivered: false, error: r.text }); return }
        if (r.kind === 'relayed') {
          if (FINAL.has(t.state)) return
          t.state = 'delivered'; t.delivered = true
          // 送的那段时间里已经来了 Stop:它本来歇着 ⇒ 那就是对这句的回话(答得比发信小进程退出还快);
          // 它本来在跑 ⇒ 多半是上一轮的收尾,丢掉、等下一个。那个 Stop 当时没被吞(照常推过了)。
          const early = t.earlyStop
          t.earlyStop = null
          if (early && !t.wasRunning) settle(t, { state: 'replied', reply: early.text!, verified: verify(t, early.text!) })
          return
        }
        if (r.kind === 'timeout') { settle(t, { state: 'timeout', ...(r.text ? { reply: r.text } : {}) }); return }
        settle(t, { state: 'replied', reply: r.text })
      }, (err) => settle(t, { state: 'failed', delivered: false, error: err instanceof Error ? err.message : String(err) }))
      return { ok: true, ticket: id, via, code: short, source: s.source, project, was_running: t.wasRunning, read_only: via === 'resume', max_wait_ms: maxWaitMs }
    },

    async wait(ticket, waitMs, signal) {
      const t = tickets.get(ticket)
      if (!t) return null
      if (FINAL.has(t.state) || waitMs <= 0 || signal?.aborted) return toView(t)
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer); t.waiters.delete(done); signal?.removeEventListener('abort', done); resolve() }
        const timer = setTimeout(done, waitMs)
        t.waiters.add(done)
        signal?.addEventListener('abort', done, { once: true })
      })
      // 领没领走由调用方回包写出去之后 claim() 说了算(断开 / 没写出去 ⇒ 不算)
      return toView(t)
    },

    view(ticket) { const t = tickets.get(ticket); return t ? toView(t) : null },

    claim(ticket) { const t = tickets.get(ticket); if (t) claim(t) },

    markPushed(sessionId) {
      for (const t of tickets.values()) {
        if (t.sessionId !== sessionId || t.unhandedText === null) continue
        t.pushedText = redactSecrets(t.unhandedText)
        t.unhandedText = null
        if (ownerHasReply(t) && t.claimTimer) { clearTimeout(t.claimTimer); t.claimTimer = null }
      }
    },

    noteEvent(ev) {
      if (ev.kind !== 'stop' && ev.kind !== 'session_end') return false
      let handed = false
      for (const t of tickets.values()) {
        if (t.via !== 'window' || t.sessionId !== ev.session_id || FINAL.has(t.state)) continue
        if (!sameSession(t, ev)) { deps.log('TERMINAL_SAY', `${t.id} ignored ${ev.kind}: identity mismatch`); continue }
        if (ev.kind === 'session_end') { settle(t, { state: 'ended' }); continue }
        const text = ev.text ?? ''
        // 空的 Stop(没带最后一句)不算回话:接着等,照常推
        if (!text.trim()) continue
        // 还在送:先记下,送完再判归属(见 say);这时没人能把它带回去,照常推
        if (t.state === 'sending') { t.earlyStop = ev; t.unhandedText = text; continue }
        const mine = t.waiters.size > 0
        if (mine) handed = true
        else t.unhandedText = text   // 没被吞 ⇒ 调用方照常推;推了(markPushed)就记下主人已经收到
        settle(t, { state: 'replied', reply: text, verified: verify(t, text) })
      }
      return handed
    },

    dispose() {
      for (const t of tickets.values()) { releaseBusy(t); if (t.claimTimer) clearTimeout(t.claimTimer); wake(t) }
      tickets.clear()
    },
  }
}
