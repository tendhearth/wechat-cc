import { type PermissionDisplay } from '@wechat-cc/protocol'
/**
 * cli-permission-relay.ts — 终端 claude / codex 的 PermissionRequest hook 把「要不要
 * 放行」送到微信里问主人(spec 2026-09-09-cli-hook-push-design §6.3)。
 *
 * 纯逻辑:微信怎么发、y/n 怎么收都在 ilink 的 askUser / PendingPermissions 里 —— 这里只
 * 复用它(所以桌宠的权限卡也会同时显示这一条:一个权限,几个呈现面)。
 *
 * 为什么是「登记 + 轮询」而不是一次长连接:hook 那头是子进程,总时限它自己掐;
 * daemon 这头一次 GET 最多等 25s 再回,不依赖任何 HTTP 空闲超时的默契。
 */
import { RULE_NOT_SAVED, type RememberApproval, type RememberHistory } from '../domain/permission-rules/types'
import type { PermissionDecision } from '../ports/workbench'
import { randomBytes } from '../lib/random'
import type { CliPresence, CliSource } from './cli-events'
import { cliSourceLabel } from '../domain/cli-session-digest'

export interface CliPermissionRequest {
  source: CliSource
  session_id: string
  cwd: string
  tool_name: string
  /** 工具参数摘要(hook 侧已压好)。 */
  summary?: string
  display?: PermissionDisplay | undefined
  execution_cwd?: string | undefined
  truncated?: boolean | undefined
  /** 命令原文(截 2000)与涉及的文件 —— 放行规则只认这两样,不从 summary 猜(2026-10-19)。 */
  command?: string
  paths?: string[]
  /** hook 那头探到的本机空闲秒数(在场判断的主信号)。 */
  idle_s?: number
  /** Absolute deadline from the local hook's total budget. */
  deadline_at?: number
  /** hook 那头的主机名;与 daemon 不同 ⇒ 卡片写「那边」。 */
  origin_agent?: string | undefined
  terminal?: import('@wechat-cc/protocol').TerminalLocation | undefined
  machine?: string
}

export type CliPermissionStatus = 'pending' | 'allow' | 'deny' | 'timeout' | 'undelivered' | 'unknown'
export type CliPermissionOpen = { status: 'pending'; hash: string } | { status: 'owner_present' }

/** 微信里等主人回 y/n 的时限。hook 那头的总时限要比这个长一点。 */
export const CLI_PERMISSION_WAIT_MS = 120_000
/** 已决条目再留多久供 hook 轮询到结果。 */
const RETAIN_MS = 5 * 60_000
/**
 * 「以后这类都不用问」只在 hook 还在等这张卡时才写规则:正有一次长轮询挂着,或上一次刚结束(两次轮询之间的空档)。
 * hook 被取消 / 被杀时没人会告诉我们,这一条就是兜底 —— 那张卡还能单次批(无害,终端已经不听了),但不再写规则。
 */
export const HOOK_POLL_GAP_MS = 3_000
const HASH_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

export interface CliPermissionCardContext {
  req: CliPermissionRequest
  projectName: string
  rememberRule?: string
  onDecision?: (decision: PermissionDecision) => boolean | string
  deadline?: () => number
}

export interface CliPermissionRelayDeps {
  /**
   * = ilink.askUser 对主人 chat 的封装(+ 手机 app 推送,见 features/terminal/app-push.ts);谁都够不着时应
   * resolve 'undelivered'。第四个参数是这条请求本身与算好的项目名,给推送的深链与正文用。
   */
  ask: (prompt: string, hash: string, timeoutMs: number, ctx: CliPermissionCardContext) => Promise<'allow' | 'deny' | 'timeout' | 'undelivered'>
  presence: (sessionId: string, idleS?: number | null) => Promise<CliPresence>
  projectName: (cwd: string) => string
  /** 卡片发出去了 —— hub 据此压掉紧随其后的「等你批准」提醒。 */
  onRelayed: (sessionId: string) => void
  log: (tag: string, line: string) => void
  /** 请求一来(在场判断之前)就报一声 —— 终端会话登记处据此记 waiting(v76)。 */
  onAsked?: (req: CliPermissionRequest) => void
  /** 有了结果(allow / deny / timeout / undelivered)—— 登记处据此把 waiting 放回 running。 */
  onSettled?: (sessionId: string, status: CliPermissionStatus, ownerPermission?: RememberHistory) => boolean | void
  onRuleAdded?: (sessionId: string, line: string) => void
  onExpired?: () => void
  remember?: (req: CliPermissionRequest) => Promise<RememberApproval | undefined>
  waitMs?: number
  localMachine?: string
  /**
   * 放行规则(2026-10-19):开码之后、问主人之前先问它。allow / deny ⇒ 码直接落定,不发卡片;ask / 抛 ⇒ 老路。
   * 在后台跑 —— hook 的 POST 只等 5 秒,初审最多 8 秒,所以 open() 不等它。没接 ⇒ 与改造前逐字节相同。
   */
  decide?: (req: CliPermissionRequest, ownerHook: boolean) => Promise<'allow' | 'deny' | 'ask'>
}

export interface CliPermissionRelay {
  /** forwarded = 经 a2a 从别的机器转进来的 —— 不进放行规则(只认本机主人的会话)。 */
  open(req: CliPermissionRequest, opts?: { forwarded?: boolean; ownerHook?: boolean }): Promise<CliPermissionOpen>
  status(hash: string): CliPermissionStatus
  /** 等到状态离开 pending 或 maxMs 到点;返回当时的状态。 */
  wait(hash: string, maxMs: number): Promise<CliPermissionStatus>
  /**
   * 这条会话现在挂着的、由本中继开出去的待批码(还在 pending)。没有 ⇒ null —— 主人在场时
   * 留给终端自己问(owner_present)、或这只手把请求转给了脑,都没有码,手机上也就拍不了。
   */
  pendingHash(sessionId: string): string | null
  /** 这个码是不是本中继开的、且还在等。手机拍板只认这些,不让它顺手批掉别的待批(自改、工作台)。 */
  owns(hash: string): boolean
  rememberRule(hash: string): string | undefined
  /** Hook 已经退出这次请求。 */
  expire(hash: string): void
  /** 这条会话还挂着的码全部以 timeout 落定(会话又有了事件 ⇒ 终端已经自己答过)。 */
  expireSession(sessionId: string): void
  dispose(): void
}

interface Entry { sessionId: string; status: CliPermissionStatus; rememberRule?: string; waiters: (() => void)[]; polling: number; lastPollAt: number; timer?: ReturnType<typeof setTimeout>; retain?: ReturnType<typeof setTimeout> }

/** 5 位小写字母数字 —— PERMISSION_REPLY_RE 只认恰好 5 位。 */
export function newPermissionHash(): string {
  const bytes = randomBytes(5)
  let out = ''
  for (let i = 0; i < 5; i++) out += HASH_ALPHABET[bytes[i]! % HASH_ALPHABET.length]
  return out
}

export function formatCliPermissionPrompt(req: CliPermissionRequest, projectName: string, hash: string, waitMs: number, localMachine?: string): string {
  const remote = req.machine && localMachine && req.machine !== localMachine ? ` · 那边(${req.machine})` : ''
  const head = `${cliSourceLabel(req.source)} 等你批准${remote} · ${projectName} · 码 ${req.session_id.slice(0, 6)}`
  const what = req.summary ? `${req.tool_name}: ${req.summary}` : req.tool_name
  // 「怎么回」那一行由 ilink-glue.askUser 统一加(两位数码在那里分配);这里只说过期后会怎样。
  void hash; void waitMs
  return `${head}\n${what}\n过期终端自己会问。`
}

export function makeCliPermissionRelay(deps: CliPermissionRelayDeps): CliPermissionRelay {
  const waitMs = deps.waitMs ?? CLI_PERMISSION_WAIT_MS
  const entries = new Map<string, Entry>()

  function settle(hash: string, status: CliPermissionStatus, ownerPermission?: RememberHistory): boolean {
    const e = entries.get(hash)
    if (!e || e.status !== 'pending') return false
    e.status = status
    clearTimeout(e.timer)
    let audited = false
    try { audited = deps.onSettled ? deps.onSettled(e.sessionId, status, ownerPermission) !== false : false }
    catch { /* 登记处出错不影响本次拍板。 */ }
    for (const w of e.waiters) w()
    e.waiters = []
    e.retain = setTimeout(() => { entries.delete(hash) }, RETAIN_MS)
    e.retain.unref?.()
    return audited
  }

  function expire(hash: string): void {
    if (entries.get(hash)?.status !== 'pending') return
    settle(hash, 'timeout')
    deps.onExpired?.()
  }

  return {
    async open(req, opts) {
      const received = Date.now()
      const local = !req.machine || !deps.localMachine || req.machine === deps.localMachine
      const hookDeadline = opts?.ownerHook || opts?.forwarded ? req.deadline_at : undefined
      const expiresAt = Math.min(received + waitMs, hookDeadline ?? Infinity)
      const present = await deps.presence(req.session_id, req.idle_s) === 'present'
      if (present) {
        deps.log('CLI_PERMISSION', `owner present for ${req.session_id.slice(0, 6)}: leave it to the terminal`)
        return { status: 'owner_present' }
      }
      // 只在真开了码(主人不在、手机 / 微信能拍)时才记 waiting:主人在终端前自己答的那种,
      // 不会再有事件告诉我们答完了,记了就会一直挂着「等你批准」(评审 10-15 #1)。
      try { deps.onAsked?.(req) } catch { /* 登记处出错不影响中继 */ }
      let hash = newPermissionHash()
      while (entries.has(hash)) hash = newPermissionHash()
      const entry: Entry = { sessionId: req.session_id, status: 'pending', waiters: [], polling: 0, lastPollAt: received }
      entries.set(hash, entry)
      entry.timer = setTimeout(() => expire(hash), Math.max(0, expiresAt - Date.now()))
      entry.timer.unref?.()
      const active = () => {
        if (entry.status !== 'pending' || entries.get(hash) !== entry) return false
        if (Date.now() < expiresAt) return true
        expire(hash)
        return false
      }
      const askOwner = async () => {
        const approval = opts?.ownerHook && !opts.forwarded && local && deps.remember
          ? await deps.remember(req).catch(() => undefined) : undefined
        if (!active()) return
        if (approval?.preview) entry.rememberRule = approval.preview
        const onDecision = approval ? (decision: PermissionDecision) => {
          if (!active() || decision === 'allow_task') return false
          const verdict = decision === 'deny' ? 'deny' : 'allow'
          let eligible = false
          const hookWaiting = entry.polling > 0 || Date.now() - entry.lastPollAt <= HOOK_POLL_GAP_MS
          if (decision === 'allow_always' && hookWaiting) {
            try { eligible = approval.eligible?.() !== false } catch { /* The one-shot decision can still be recorded. */ }
          }
          if (!active()) return false
          const audited = settle(hash, verdict, { key: approval.key, verdict })
          if (decision !== 'allow_always') return true
          if (!audited || !eligible) return RULE_NOT_SAVED
          let saved: ReturnType<RememberApproval['save']>
          try { saved = approval.save(() => Date.now() < expiresAt) }
          catch { return RULE_NOT_SAVED }
          if (!saved) return RULE_NOT_SAVED
          if (saved.added) {
            try { deps.onRuleAdded?.(entry.sessionId, `你加了一条规则：${saved.line}`) }
            catch { deps.log('CLI_PERMISSION', 'rule saved but receipt audit failed') }
          }
          return saved.line
        } : undefined
        let projectName: string
        try { projectName = deps.projectName(req.cwd) } catch { projectName = req.cwd }
        if (!active()) return
        const remaining = expiresAt - Date.now()
        const prompt = formatCliPermissionPrompt(req, projectName, hash, remaining, deps.localMachine)
        deps.onRelayed(req.session_id)
        deps.log('CLI_PERMISSION', `asking wechat for ${req.source}/${req.session_id.slice(0, 6)} ${req.tool_name} hash=${hash}`)
        deps.ask(prompt, hash, remaining, { req, projectName, deadline: () => entry.status === 'pending' ? expiresAt : 0, ...(approval?.preview ? { rememberRule: approval.preview } : {}), ...(onDecision ? { onDecision } : {}) }).then(
          (answer) => { deps.log('CLI_PERMISSION', `${answer} hash=${hash}`); settle(hash, answer) },
          (err) => { deps.log('CLI_PERMISSION', `ask failed hash=${hash}: ${err instanceof Error ? err.message : String(err)}`); settle(hash, 'undelivered') },
        )
      }
      if (!deps.decide || opts?.forwarded || !local) { askOwner(); return { status: 'pending', hash } }
      // 下一个宏任务才开始判:hook 的 POST 先拿到 pending,判规则里哪怕有同步的活也不压在这一路上(终审 10-19)。
      const decide = deps.decide
      void new Promise<void>(res => { const t = setTimeout(res, 0); (t as { unref?: () => void }).unref?.() })
        .then(() => (active() ? decide(req, opts?.ownerHook === true) : 'ask' as const)).catch(() => 'ask' as const).then((verdict) => {
        if (!active()) return   // 等规则期间码已作废(会话又有了动静)
        if (verdict === 'allow' || verdict === 'deny') {
          deps.log('CLI_PERMISSION', `${verdict} by rules hash=${hash}`)
          settle(hash, verdict)
        } else askOwner()
      })
      return { status: 'pending', hash }
    },
    status(hash) {
      return entries.get(hash)?.status ?? 'unknown'
    },
    wait(hash, maxMs) {
      const e = entries.get(hash)
      if (!e) return Promise.resolve('unknown')
      if (e.status !== 'pending') return Promise.resolve(e.status)
      e.polling++
      e.lastPollAt = Date.now()
      return new Promise((resolve) => {
        let done = false
        const finish = () => { if (done) return; done = true; clearTimeout(t); e.polling--; e.lastPollAt = Date.now(); resolve(entries.get(hash)?.status ?? 'unknown') }
        const t = setTimeout(finish, maxMs)
        ;(t as { unref?: () => void }).unref?.()
        e.waiters.push(finish)
      })
    },
    pendingHash(sessionId) {
      let found: string | null = null
      // Map 按插入序:同一会话有多条时取最新开的那条。
      for (const [h, e] of entries) if (e.sessionId === sessionId && e.status === 'pending') found = h
      return found
    },
    owns(hash) {
      return entries.get(hash)?.status === 'pending'
    },
    rememberRule(hash) { const e = entries.get(hash); return e?.status === 'pending' ? e.rememberRule : undefined },
    expire,
    expireSession(sessionId) {
      // 这条会话又有了动静(Stop / 新 prompt / 结束):终端那头已经自己答过了,
      // 还挂着的码作废 —— 否则手机点「允许」会回 ok,其实没人在等(评审 10-15 #5)。
      for (const [h, e] of entries) if (e.sessionId === sessionId && e.status === 'pending') expire(h)
    },
    dispose() {
      for (const e of entries.values()) { clearTimeout(e.timer); if (e.retain) clearTimeout(e.retain); for (const w of e.waiters) w() }
      entries.clear()
    },
  }
}
