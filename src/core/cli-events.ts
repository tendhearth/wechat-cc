/**
 * cli-events.ts — 主人自己在终端开的 claude / codex 会话,经两家的 hooks 报进来的
 * 事件,在这里决定「发不发、发到哪个面、怎么措辞」(spec 2026-09-09-cli-hook-push-design)。
 *
 * 纯逻辑:没有 HTTP、没有 ilink。发送、桌面通知、空闲探针、share_page 都由调用方注入。
 *
 * 在场判断(§5):主信号是「这台电脑有没有人在用」(空闲秒数),副信号是「这条会话
 * 最近敲没敲字」。人在电脑前 ⇒ 落桌面通知;机器空闲够久 ⇒ 走微信。不看手机那头
 * 的活动 —— 主人可能半天不回,那不说明他不在。
 *
 * 为什么要压一段时间再发:Stop 之后主人在场多半会马上再输入(UserPromptSubmit),那就撤;
 * 权限同理但压得短。发送失败只记日志、丢弃 —— 断线不重试。
 */

export type CliSource = 'claude' | 'codex'
export type CliEventKind = 'stop' | 'prompt' | 'permission' | 'session_end'

export interface CliEvent {
  source: CliSource
  kind: CliEventKind
  session_id: string
  cwd: string
  /** stop 的最后一句 / permission 的工具摘要。 */
  text?: string
  /**
   * prompt 不是主人敲的,是 harness 自己塞的(/loop 唤醒、后台任务通知……)。
   * 这种 prompt 不算「主人回来了」:不撤待发、不刷在场、不重置「已推过」。
   * 不然一个自跑的循环每个 tick 都会推一条(2026-09-09 真机就是这么刷的)。
   */
  automated?: boolean
  /** hook 那头的 transcript 路径(「看 码」用它渲染会话尾巴)。 */
  transcript_path?: string
  /** hook 那头探到的本机空闲秒数;探不到就不带。 */
  idle_s?: number
  /** hook 那头的主机名。与 daemon 所在机器不同 ⇒ 「那边」。 */
  machine?: string
}

export type CliEventAction = 'scheduled' | 'cancelled' | 'cleared' | 'noop'

/** Stop 之后压多久再发 —— 主人在场时这段时间内多半会再敲一句。 */
export const STOP_HOLD_MS = 45_000
/** 权限请求压多久 —— 在场的话几秒内就答了。 */
export const PERMISSION_HOLD_MS = 20_000
/** 最多同时跟踪的会话数;超出丢最旧的。 */
export const MAX_TRACKED_SESSIONS = 64
/** 从主人敲下 prompt 到 Stop 不足这么久 ⇒ 「快问快答」,主人多半还在屏幕前,不推。 */
export const MIN_TURN_MS = 90_000
/** 最近这么久内敲过 prompt ⇒ 在场(没有空闲秒数时的副信号)。 */
export const PRESENT_WINDOW_MS = 180_000
/** 机器上次键鼠输入距今不足这么多秒 ⇒ 有人在用这台电脑。 */
export const PRESENT_IDLE_S = 120
/** hook 报来的空闲秒数多久内算新鲜。 */
export const IDLE_FRESH_MS = 5 * 60_000
/** 刚在微信里问过这条会话的权限(卡片就是通知)⇒ 这段时间内的「等你批准」提醒不重复推。 */
export const RELAY_SUPPRESS_MS = 60_000
/** 完整放进微信的最后一句上限;更长的走 share_page 附链接。 */
export const INLINE_MAX = 1200
/** 多条会话先后完成,这段时间内的合成一条发。 */
export const DIGEST_WINDOW_MS = 15_000
const DESKTOP_BODY_MAX = 120
const MAX_SESSION_STATES = 256

export type CliPresence = 'present' | 'away' | 'unknown'

export interface CliSessionInfo {
  session_id: string
  source: CliSource
  cwd: string
  machine?: string
  transcript_path?: string
  lastSeenAt: number
}

export interface CliEventHubDeps {
  /** 推到主人微信。false = 没有主人 chat / 没接外发(记日志、丢弃)。 */
  send: (text: string) => Promise<boolean>
  projectName: (cwd: string) => string
  log: (tag: string, line: string) => void
  /** 人在电脑前时的面。缺席 ⇒ 在场时干脆不发(人就在终端前)。 */
  notifyDesktop?: (title: string, body: string) => Promise<boolean>
  /** 发送时刻再探一次本机空闲(只对本机会话)。 */
  machineIdle?: () => Promise<number | null>
  /** 超长全文 → 页面链接;缺席或失败 ⇒ 截断。 */
  sharePage?: (title: string, markdown: string) => Promise<string | null>
  /** daemon 所在机器的主机名;事件里的 machine 与之不同 ⇒ 「那边」。 */
  localMachine?: string
  holds?: { stop?: number; permission?: number }
  now?: () => number
}

export interface CliEventHub {
  ingest(ev: CliEvent): CliEventAction
  /**
   * 主人在不在这条会话前。可传一份刚探到的空闲秒数(权限中继的 POST 带着);
   * 没有就用最近报来的(新鲜的)或本机现探;都没有回落到「最近敲没敲字」。
   */
  presence(sessionId: string, idleS?: number | null): Promise<CliPresence>
  /** 权限中继刚在微信里问过这条会话 ⇒ 之后 RELAY_SUPPRESS_MS 内的 permission 提醒不推。 */
  notePermissionRelay(sessionId: string): void
  /** 见过的会话(「看 码」「@码」按前缀找)。 */
  lookup(codePrefix: string): CliSessionInfo | null
  sessions(): CliSessionInfo[]
  pending(): { session_id: string; kind: CliEventKind }[]
  /** 把合并窗里攒着的立刻发掉(测试 / 关机用)。 */
  flush(): Promise<void>
  dispose(): void
}

interface Pending { kind: CliEventKind; timer: ReturnType<typeof setTimeout> }
interface SessionState {
  info: CliSessionInfo
  lastPromptAt?: number
  pushedSincePrompt: boolean
  lastRelayAt?: number
  lastIdle?: { s: number; at: number }
}

export function makeCliEventHub(deps: CliEventHubDeps): CliEventHub {
  const stopHold = deps.holds?.stop ?? STOP_HOLD_MS
  const permissionHold = deps.holds?.permission ?? PERMISSION_HOLD_MS
  const now = deps.now ?? (() => Date.now())
  // Map 保持插入顺序 ⇒ 第一个就是最旧的。
  const pending = new Map<string, Pending>()
  const sessions = new Map<string, SessionState>()
  let outbox: string[] = []
  let flushTimer: ReturnType<typeof setTimeout> | null = null

  function state(ev: Pick<CliEvent, 'session_id' | 'source' | 'cwd' | 'machine' | 'transcript_path'>): SessionState {
    let st = sessions.get(ev.session_id)
    if (!st) {
      st = { info: { session_id: ev.session_id, source: ev.source, cwd: ev.cwd, lastSeenAt: now() }, pushedSincePrompt: false }
      while (sessions.size >= MAX_SESSION_STATES) {
        const oldest = sessions.keys().next().value
        if (oldest === undefined) break
        sessions.delete(oldest)
      }
      sessions.set(ev.session_id, st)
    }
    st.info.lastSeenAt = now()
    st.info.cwd = ev.cwd
    if (ev.machine) st.info.machine = ev.machine
    if (ev.transcript_path) st.info.transcript_path = ev.transcript_path
    return st
  }

  function isLocal(machine: string | undefined): boolean {
    return !machine || !deps.localMachine || machine === deps.localMachine
  }

  function cancel(sessionId: string): boolean {
    const p = pending.get(sessionId)
    if (!p) return false
    clearTimeout(p.timer)
    pending.delete(sessionId)
    return true
  }

  async function idleFor(sessionId: string, machine: string | undefined, fresh?: number | null): Promise<number | null> {
    if (typeof fresh === 'number') return fresh
    const st = sessions.get(sessionId)
    if (st?.lastIdle && now() - st.lastIdle.at < IDLE_FRESH_MS) return st.lastIdle.s
    if (isLocal(machine) && deps.machineIdle) {
      try { return await deps.machineIdle() } catch { return null }
    }
    return null
  }

  async function flush(): Promise<void> {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
    if (outbox.length === 0) return
    const batch = outbox
    outbox = []
    const text = batch.length === 1 ? batch[0]! : batch.join('\n\n— — —\n\n')
    try {
      const ok = await deps.send(text)
      deps.log('CLI_PUSH', ok ? `sent ${batch.length} item(s) to wechat` : `dropped ${batch.length} item(s): no operator chat or no sender`)
    } catch (err) {
      // 不重试:外发那一层自己有退避;这里排队只会在断线时堆成风暴。
      deps.log('CLI_PUSH', `send failed (${batch.length} item(s)): ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  function enqueue(text: string): void {
    outbox.push(text)
    if (!flushTimer) {
      flushTimer = setTimeout(() => { void flush() }, DIGEST_WINDOW_MS)
      ;(flushTimer as { unref?: () => void }).unref?.()
    }
  }

  async function fire(ev: CliEvent): Promise<void> {
    pending.delete(ev.session_id)
    const projectName = safeProjectName(deps.projectName, ev.cwd)
    const st = state(ev)
    if (ev.kind === 'stop') st.pushedSincePrompt = true
    const idle = await idleFor(ev.session_id, ev.machine)
    const header = formatCliHeader(ev, projectName, deps.localMachine)
    if (idle !== null && idle < PRESENT_IDLE_S) {
      // 人就在这台电脑前:落桌面,不进微信。没有桌面面就算了 —— 终端就在眼前。
      const body = ev.text ? summarizeOneLine(stripMarkdown(ev.text), DESKTOP_BODY_MAX) : ''
      const ok = deps.notifyDesktop ? await deps.notifyDesktop(header, body).catch(() => false) : false
      deps.log('CLI_PUSH', `${ok ? 'desktop' : 'skip'} ${ev.source}/${ev.kind} ${short(ev.session_id)}: machine idle ${Math.round(idle)}s`)
      return
    }
    let link: string | null = null
    const full = ev.text ? stripMarkdown(ev.text) : ''
    if (full.length > INLINE_MAX && deps.sharePage) {
      try { link = await deps.sharePage(header, ev.text!) } catch { link = null }
    }
    enqueue(formatCliPush(ev, projectName, { localMachine: deps.localMachine, link }))
    deps.log('CLI_PUSH', `queued ${ev.source}/${ev.kind} ${short(ev.session_id)}${idle === null ? '' : ` (machine idle ${Math.round(idle)}s)`}`)
  }

  function schedule(ev: CliEvent, ms: number): CliEventAction {
    cancel(ev.session_id)
    while (pending.size >= MAX_TRACKED_SESSIONS) {
      const oldest = pending.keys().next().value
      if (oldest === undefined) break
      cancel(oldest)
    }
    const timer = setTimeout(() => { void fire(ev) }, ms)
    ;(timer as { unref?: () => void }).unref?.()
    pending.set(ev.session_id, { kind: ev.kind, timer })
    return 'scheduled'
  }

  return {
    ingest(ev) {
      const t = now()
      const st = state(ev)
      if (typeof ev.idle_s === 'number') st.lastIdle = { s: ev.idle_s, at: t }
      switch (ev.kind) {
        case 'stop': {
          // 这次敲字之后已经推过「完成了」:再多的 Stop(自动续跑、循环 tick)
          // 都不是新消息 —— 主人没说话,就最多告诉他一次。
          if (st.pushedSincePrompt) { deps.log('CLI_PUSH', `skip stop ${short(ev.session_id)}: already pushed since last prompt`); return 'noop' }
          if (st.lastPromptAt !== undefined && t - st.lastPromptAt < MIN_TURN_MS) {
            deps.log('CLI_PUSH', `skip stop ${short(ev.session_id)}: quick turn (${Math.round((t - st.lastPromptAt) / 1000)}s)`)
            return 'noop'
          }
          return schedule(ev, stopHold)
        }
        case 'permission': {
          if (st.lastRelayAt !== undefined && t - st.lastRelayAt < RELAY_SUPPRESS_MS) {
            deps.log('CLI_PUSH', `skip permission ${short(ev.session_id)}: relayed to wechat ${Math.round((t - st.lastRelayAt) / 1000)}s ago`)
            return 'noop'
          }
          return schedule(ev, permissionHold)
        }
        case 'prompt': {
          if (ev.automated) { deps.log('CLI_PUSH', `ignore automated prompt ${short(ev.session_id)}`); return 'noop' }
          st.lastPromptAt = t
          st.pushedSincePrompt = false
          return cancel(ev.session_id) ? 'cancelled' : 'noop'
        }
        case 'session_end':
          sessions.delete(ev.session_id)
          return cancel(ev.session_id) ? 'cleared' : 'noop'
      }
    },
    async presence(sessionId, idleS) {
      const st = sessions.get(sessionId)
      const idle = await idleFor(sessionId, st?.info.machine, idleS)
      if (idle !== null) return idle < PRESENT_IDLE_S ? 'present' : 'away'
      if (!st || st.lastPromptAt === undefined) return 'unknown'
      return now() - st.lastPromptAt < PRESENT_WINDOW_MS ? 'present' : 'away'
    },
    notePermissionRelay(sessionId) {
      const st = sessions.get(sessionId)
      if (st) st.lastRelayAt = now()
      else sessions.set(sessionId, { info: { session_id: sessionId, source: 'claude', cwd: '', lastSeenAt: now() }, pushedSincePrompt: false, lastRelayAt: now() })
    },
    lookup(codePrefix) {
      const p = codePrefix.trim().toLowerCase()
      if (!p) return null
      let best: CliSessionInfo | null = null
      for (const st of sessions.values()) {
        if (!st.info.session_id.toLowerCase().startsWith(p)) continue
        if (!best || st.info.lastSeenAt > best.lastSeenAt) best = st.info
      }
      return best
    },
    sessions() {
      return [...sessions.values()].map(s => ({ ...s.info })).sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    },
    pending() {
      return [...pending.entries()].map(([session_id, p]) => ({ session_id, kind: p.kind }))
    },
    flush,
    dispose() {
      for (const p of pending.values()) clearTimeout(p.timer)
      pending.clear()
      sessions.clear()
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
      outbox = []
    },
  }
}

function short(sessionId: string): string {
  return sessionId.slice(0, 6)
}

function safeProjectName(fn: (cwd: string) => string, cwd: string): string {
  try { return fn(cwd) } catch { return basename(cwd) }
}

/** 压成一行、截到上限;空串原样。 */
export function summarizeOneLine(text: string, max = DESKTOP_BODY_MAX): string {
  const one = text.replace(/\s+/g, ' ').trim()
  if (one.length <= max) return one
  return one.slice(0, max - 1) + '…'
}

/**
 * 微信不认 markdown:去掉记号、留下结构。星号粗体、反引号、标题井号、列表点、链接。
 * 段落间最多留一个空行。
 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/```[a-zA-Z0-9_-]*\n?/g, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '· ')
    .replace(/^\s*>\s?/gm, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 标题行:哪家 · 干了什么 · 哪台机(非本机才写)· 项目 · 会话短码。 */
export function formatCliHeader(ev: CliEvent, projectName: string, localMachine?: string): string {
  const verb = ev.kind === 'permission' ? '等你批准' : '完成了'
  const icon = ev.kind === 'permission' ? '✋' : '🔔'
  const remote = ev.machine && localMachine && ev.machine !== localMachine ? ` · 那边(${ev.machine})` : ''
  return `${icon} ${ev.source} ${verb}${remote} · ${projectName} · 会话 ${short(ev.session_id)}`
}

/**
 * 主人一眼要看到的:哪家、哪台机、哪个项目、哪个会话、要他干什么,然后是**完整**的
 * 最后一句(去 markdown 记号)。超过 INLINE_MAX 才截,截了就附全文链接。
 */
export function formatCliPush(ev: CliEvent, projectName: string, opts: { localMachine?: string; link?: string | null } = {}): string {
  const head = formatCliHeader(ev, projectName, opts.localMachine)
  if (ev.kind === 'permission') {
    const lines = [head]
    if (ev.text) lines.push(summarizeOneLine(stripMarkdown(ev.text), 200))
    lines.push('(回终端处理;这一类微信里暂时答不了)')
    return lines.join('\n')
  }
  if (!ev.text) return head
  const full = stripMarkdown(ev.text)
  if (full.length <= INLINE_MAX) return `${head}\n${full}`
  const cut = full.slice(0, INLINE_MAX - 1) + '…'
  return opts.link ? `${head}\n${cut}\n全文:${opts.link}` : `${head}\n${cut}`
}

function basename(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? p
}

/**
 * cwd → 项目名:对已登记项目的 path 做最长前缀匹配(目录边界对齐),
 * 没命中或列表读不到就用 cwd 末段目录名。
 */
export function makeProjectNamer(
  list: () => readonly { alias: string; path: string }[],
): (cwd: string) => string {
  return (cwd) => {
    let items: readonly { alias: string; path: string }[]
    try { items = list() } catch { return basename(cwd) }
    const norm = (s: string) => s.replace(/[\\/]+$/, '')
    const c = norm(cwd)
    let best: { alias: string; len: number } | null = null
    for (const it of items) {
      const p = norm(it.path)
      if (!p) continue
      if (c === p || c.startsWith(p + '/') || c.startsWith(p + '\\')) {
        if (!best || p.length > best.len) best = { alias: it.alias, len: p.length }
      }
    }
    return best?.alias ?? basename(cwd)
  }
}
