/**
 * cli-events.ts — 主人自己在终端开的 claude / codex 会话,经两家的 hooks 报进来的
 * 事件,在这里决定「发不发、怎么措辞」(spec 2026-09-09-cli-hook-push-design)。
 *
 * 纯逻辑:没有 HTTP、没有 ilink。发送与项目名解析都由调用方注入。
 *
 * 为什么要压一段时间再发:hook 不知道主人是不是正坐在终端前。Stop 之后主人在场
 * 多半会马上再输入(UserPromptSubmit),那就撤;权限同理但压得短。发送失败只记
 * 日志、丢弃 —— 断线不重试(仓库规则:退避必须指数级,推送不值得排队)。
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
}

export type CliEventAction = 'scheduled' | 'cancelled' | 'cleared' | 'noop'

/** Stop 之后压多久再发 —— 主人在场时这段时间内多半会再敲一句。 */
export const STOP_HOLD_MS = 45_000
/** 权限请求压多久 —— 在场的话几秒内就答了。 */
export const PERMISSION_HOLD_MS = 20_000
/** 最多同时跟踪的会话数;超出丢最旧的。 */
export const MAX_TRACKED_SESSIONS = 64
/**
 * 从主人敲下 prompt 到 Stop 不足这么久 ⇒ 「快问快答」,主人多半还在屏幕前,不推。
 * Anthropic 自家 PushNotification 的准则也是 quick task 不打扰。
 */
export const MIN_TURN_MS = 90_000
/** 最近这么久内敲过 prompt ⇒ 在场(权限走终端自己的提示,不去微信问)。 */
export const PRESENT_WINDOW_MS = 180_000
/** 刚在微信里问过这条会话的权限(卡片就是通知)⇒ 这段时间内的「等你批准」提醒不重复推。 */
export const RELAY_SUPPRESS_MS = 60_000
const SUMMARY_MAX = 120

export interface CliEventHubDeps {
  /** 推到主人私聊。false = 没有主人 chat / 没接外发(记日志、丢弃)。 */
  send: (text: string) => Promise<boolean>
  projectName: (cwd: string) => string
  log: (tag: string, line: string) => void
  holds?: { stop?: number; permission?: number }
  now?: () => number
}

export type CliPresence = 'present' | 'away' | 'unknown'

export interface CliEventHub {
  ingest(ev: CliEvent): CliEventAction
  /** 主人最近有没有在这条会话敲过字(PRESENT_WINDOW_MS 内)。没见过 prompt ⇒ unknown。 */
  presence(sessionId: string): CliPresence
  /** 权限中继刚在微信里问过这条会话 ⇒ 之后 RELAY_SUPPRESS_MS 内的 permission 提醒不推。 */
  notePermissionRelay(sessionId: string): void
  pending(): { session_id: string; kind: CliEventKind }[]
  dispose(): void
}

interface Pending { kind: CliEventKind; timer: ReturnType<typeof setTimeout> }
/** 每条会话记三样:主人最近一次敲字、这次敲字之后推没推过「完成了」、最近一次微信里问权限。 */
interface SessionState { lastPromptAt?: number; pushedSincePrompt: boolean; lastRelayAt?: number }
const MAX_SESSION_STATES = 256

export function makeCliEventHub(deps: CliEventHubDeps): CliEventHub {
  const stopHold = deps.holds?.stop ?? STOP_HOLD_MS
  const permissionHold = deps.holds?.permission ?? PERMISSION_HOLD_MS
  const now = deps.now ?? (() => Date.now())
  // Map 保持插入顺序 ⇒ 第一个就是最旧的。
  const pending = new Map<string, Pending>()
  const sessions = new Map<string, SessionState>()

  function state(sessionId: string): SessionState {
    let st = sessions.get(sessionId)
    if (!st) {
      st = { pushedSincePrompt: false }
      while (sessions.size >= MAX_SESSION_STATES) {
        const oldest = sessions.keys().next().value
        if (oldest === undefined) break
        sessions.delete(oldest)
      }
      sessions.set(sessionId, st)
    }
    return st
  }

  function cancel(sessionId: string): boolean {
    const p = pending.get(sessionId)
    if (!p) return false
    clearTimeout(p.timer)
    pending.delete(sessionId)
    return true
  }

  async function fire(ev: CliEvent): Promise<void> {
    pending.delete(ev.session_id)
    const text = formatCliPush(ev, safeProjectName(deps.projectName, ev.cwd))
    try {
      const ok = await deps.send(text)
      if (!ok) deps.log('CLI_PUSH', `dropped ${ev.source}/${ev.kind} ${short(ev.session_id)}: no operator chat or no sender`)
      else {
        deps.log('CLI_PUSH', `sent ${ev.source}/${ev.kind} ${short(ev.session_id)}`)
        if (ev.kind === 'stop') state(ev.session_id).pushedSincePrompt = true
      }
    } catch (err) {
      // 不重试:外发那一层自己有退避;这里排队只会在断线时堆成风暴。
      deps.log('CLI_PUSH', `send failed ${ev.source}/${ev.kind} ${short(ev.session_id)}: ${err instanceof Error ? err.message : String(err)}`)
    }
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
      switch (ev.kind) {
        case 'stop': {
          const st = state(ev.session_id)
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
          const st = state(ev.session_id)
          if (st.lastRelayAt !== undefined && t - st.lastRelayAt < RELAY_SUPPRESS_MS) {
            deps.log('CLI_PUSH', `skip permission ${short(ev.session_id)}: relayed to wechat ${Math.round((t - st.lastRelayAt) / 1000)}s ago`)
            return 'noop'
          }
          return schedule(ev, permissionHold)
        }
        case 'prompt': {
          if (ev.automated) { deps.log('CLI_PUSH', `ignore automated prompt ${short(ev.session_id)}`); return 'noop' }
          const st = state(ev.session_id)
          st.lastPromptAt = t
          st.pushedSincePrompt = false
          return cancel(ev.session_id) ? 'cancelled' : 'noop'
        }
        case 'session_end':
          sessions.delete(ev.session_id)
          return cancel(ev.session_id) ? 'cleared' : 'noop'
      }
    },
    presence(sessionId) {
      const st = sessions.get(sessionId)
      if (!st || st.lastPromptAt === undefined) return 'unknown'
      return now() - st.lastPromptAt < PRESENT_WINDOW_MS ? 'present' : 'away'
    },
    notePermissionRelay(sessionId) {
      state(sessionId).lastRelayAt = now()
    },
    pending() {
      return [...pending.entries()].map(([session_id, p]) => ({ session_id, kind: p.kind }))
    },
    dispose() {
      for (const p of pending.values()) clearTimeout(p.timer)
      pending.clear()
      sessions.clear()
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
export function summarizeOneLine(text: string, max = SUMMARY_MAX): string {
  const one = text.replace(/\s+/g, ' ').trim()
  if (one.length <= max) return one
  return one.slice(0, max - 1) + '…'
}

/**
 * 主人一眼要看到的四样:哪家、哪个项目、哪个会话、要他干什么(spec §4)。
 */
export function formatCliPush(ev: CliEvent, projectName: string): string {
  const who = `${ev.source}`
  const where = `${projectName} · 会话 ${short(ev.session_id)}`
  const summary = ev.text ? summarizeOneLine(ev.text) : ''
  if (ev.kind === 'permission') {
    const lines = [`✋ ${who} 等你批准 · ${where}`]
    if (summary) lines.push(summary)
    lines.push('(回终端处理;这一类微信里暂时答不了)')
    return lines.join('\n')
  }
  const head = `🔔 ${who} 完成了 · ${where}`
  return summary ? `${head}\n${summary}` : head
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
