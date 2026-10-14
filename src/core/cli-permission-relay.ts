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
import { randomBytes } from 'node:crypto'
import type { CliPresence, CliSource } from './cli-events'

export interface CliPermissionRequest {
  source: CliSource
  session_id: string
  cwd: string
  tool_name: string
  /** 工具参数摘要(hook 侧已压好)。 */
  summary?: string
  /** hook 那头探到的本机空闲秒数(在场判断的主信号)。 */
  idle_s?: number
  /** hook 那头的主机名;与 daemon 不同 ⇒ 卡片写「那边」。 */
  machine?: string
}

export type CliPermissionStatus = 'pending' | 'allow' | 'deny' | 'timeout' | 'undelivered' | 'unknown'
export type CliPermissionOpen = { status: 'pending'; hash: string } | { status: 'owner_present' }

/** 微信里等主人回 y/n 的时限。hook 那头的总时限要比这个长一点。 */
export const CLI_PERMISSION_WAIT_MS = 120_000
/** 已决条目再留多久供 hook 轮询到结果。 */
const RETAIN_MS = 5 * 60_000
const HASH_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

export interface CliPermissionRelayDeps {
  /**
   * = ilink.askUser 对主人 chat 的封装(+ 手机 app 推送,见 daemon/cli-app-push.ts);谁都够不着时应
   * resolve 'undelivered'。第四个参数是这条请求本身与算好的项目名,给推送的深链与正文用。
   */
  ask: (prompt: string, hash: string, timeoutMs: number, ctx: { req: CliPermissionRequest; projectName: string }) => Promise<'allow' | 'deny' | 'timeout' | 'undelivered'>
  presence: (sessionId: string, idleS?: number | null) => Promise<CliPresence>
  projectName: (cwd: string) => string
  /** 卡片发出去了 —— hub 据此压掉紧随其后的「等你批准」提醒。 */
  onRelayed: (sessionId: string) => void
  log: (tag: string, line: string) => void
  /** 请求一来(在场判断之前)就报一声 —— 终端会话登记处据此记 waiting(v76)。 */
  onAsked?: (req: CliPermissionRequest) => void
  /** 有了结果(allow / deny / timeout / undelivered)—— 登记处据此把 waiting 放回 running。 */
  onSettled?: (sessionId: string, status: CliPermissionStatus) => void
  waitMs?: number
  localMachine?: string
}

export interface CliPermissionRelay {
  open(req: CliPermissionRequest): Promise<CliPermissionOpen>
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
  dispose(): void
}

interface Entry { sessionId: string; status: CliPermissionStatus; waiters: (() => void)[]; retain?: ReturnType<typeof setTimeout> }

/** 5 位小写字母数字 —— PERMISSION_REPLY_RE 只认恰好 5 位。 */
export function newPermissionHash(): string {
  const bytes = randomBytes(5)
  let out = ''
  for (let i = 0; i < 5; i++) out += HASH_ALPHABET[bytes[i]! % HASH_ALPHABET.length]
  return out
}

export function formatCliPermissionPrompt(req: CliPermissionRequest, projectName: string, hash: string, waitMs: number, localMachine?: string): string {
  const remote = req.machine && localMachine && req.machine !== localMachine ? ` · 那边(${req.machine})` : ''
  const head = `✋ ${req.source} 等你批准${remote} · ${projectName} · 会话 ${req.session_id.slice(0, 6)}`
  const what = req.summary ? `${req.tool_name}: ${req.summary}` : req.tool_name
  // 「怎么回」那一行由 ilink-glue.askUser 统一加(两位数码在那里分配);这里只说过期后会怎样。
  void hash; void waitMs
  return `${head}\n${what}\n过期终端自己会问。`
}

export function makeCliPermissionRelay(deps: CliPermissionRelayDeps): CliPermissionRelay {
  const waitMs = deps.waitMs ?? CLI_PERMISSION_WAIT_MS
  const entries = new Map<string, Entry>()

  function settle(hash: string, status: CliPermissionStatus): void {
    const e = entries.get(hash)
    if (!e) return
    e.status = status
    for (const w of e.waiters) w()
    e.waiters = []
    try { deps.onSettled?.(e.sessionId, status) } catch { /* 登记处出错不影响拍板 */ }
    e.retain = setTimeout(() => { entries.delete(hash) }, RETAIN_MS)
    ;(e.retain as { unref?: () => void }).unref?.()
  }

  return {
    async open(req) {
      try { deps.onAsked?.(req) } catch { /* 登记处出错不影响中继 */ }
      if (await deps.presence(req.session_id, req.idle_s) === 'present') {
        deps.log('CLI_PERMISSION', `owner present for ${req.session_id.slice(0, 6)}: leave it to the terminal`)
        return { status: 'owner_present' }
      }
      let hash = newPermissionHash()
      while (entries.has(hash)) hash = newPermissionHash()
      entries.set(hash, { sessionId: req.session_id, status: 'pending', waiters: [] })
      let projectName: string
      try { projectName = deps.projectName(req.cwd) } catch { projectName = req.cwd }
      const prompt = formatCliPermissionPrompt(req, projectName, hash, waitMs, deps.localMachine)
      deps.onRelayed(req.session_id)
      deps.log('CLI_PERMISSION', `asking wechat for ${req.source}/${req.session_id.slice(0, 6)} ${req.tool_name} hash=${hash}`)
      deps.ask(prompt, hash, waitMs, { req, projectName }).then(
        (answer) => { deps.log('CLI_PERMISSION', `${answer} hash=${hash}`); settle(hash, answer) },
        (err) => { deps.log('CLI_PERMISSION', `ask failed hash=${hash}: ${err instanceof Error ? err.message : String(err)}`); settle(hash, 'undelivered') },
      )
      return { status: 'pending', hash }
    },
    status(hash) {
      return entries.get(hash)?.status ?? 'unknown'
    },
    wait(hash, maxMs) {
      const e = entries.get(hash)
      if (!e) return Promise.resolve('unknown')
      if (e.status !== 'pending') return Promise.resolve(e.status)
      return new Promise((resolve) => {
        let done = false
        const finish = () => { if (done) return; done = true; clearTimeout(t); resolve(entries.get(hash)?.status ?? 'unknown') }
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
    dispose() {
      for (const e of entries.values()) { if (e.retain) clearTimeout(e.retain); for (const w of e.waiters) w() }
      entries.clear()
    },
  }
}
