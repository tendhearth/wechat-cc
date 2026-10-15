/**
 * terminal-hooks.ts(daemon 侧)— 「CC 现在怎么样」里「终端里的 Claude Code / Codex」那一行的数据,
 * 以及 POST /v1/cli/hooks/install|uninstall 的执行体(2026-10-14)。
 *
 * 判定与写文件都在 src/cli/terminal-hooks.ts(CLI `hook install` 同一份);这里只加两样:
 *   - 找 CLI 要 spawn `which`,能力表每 10 秒算一次 ⇒ 找到的结果缓存 LOCATE_TTL_MS,装 / 撤之后清掉;
 *   - 登记处里最近 7 天有动静的会话数。
 * 永远不自己装:只有主人在桌面上点了确认(路由)才写 ~/.claude/settings.json / $CODEX_HOME/hooks.json。
 */
import {
  connectTerminalHooks, disconnectTerminalHooks, isPresent, readTerminalHooks,
  type HookChange, type HookSourceState, type TerminalHooksDeps,
} from '../cli/terminal-hooks'
import type { HookSource } from '../cli/hook'
import type { CapabilityInputs } from './capabilities'

export const LOCATE_TTL_MS = 5 * 60_000
export const SESSIONS_WINDOW_MS = 7 * 24 * 3600_000

export interface TerminalHooksResult { ok: boolean; results: HookChange[]; status: HookSourceState[] }

export interface TerminalHooksService {
  status(): HookSourceState[]
  /** 能力表的输入;一家都没有 ⇒ null(那一行不出现)。 */
  capabilityInput(): NonNullable<CapabilityInputs['terminal']> | null
  install(sources?: readonly HookSource[]): TerminalHooksResult
  uninstall(sources?: readonly HookSource[]): TerminalHooksResult
}

export function makeTerminalHooksService(opts: {
  deps: () => TerminalHooksDeps
  /** 登记处里的会话(含已结束的)。读不到就当 0。 */
  sessions: () => Array<{ last_event_at: number }>
  now?: () => number
}): TerminalHooksService {
  const now = opts.now ?? (() => Date.now())
  const located = new Map<HookSource, { at: number; path: string | null }>()
  const deps = (): TerminalHooksDeps => {
    const d = opts.deps()
    return {
      ...d,
      locate: (s) => {
        const hit = located.get(s)
        if (hit && now() - hit.at < LOCATE_TTL_MS) return hit.path
        let path: string | null = null
        try { path = d.locate(s) } catch { path = null }
        located.set(s, { at: now(), path })
        return path
      },
    }
  }
  const status = () => readTerminalHooks(deps())
  const done = (results: HookChange[]): TerminalHooksResult => { located.clear(); return { ok: results.every(r => r.ok), results, status: status() } }
  return {
    status,
    capabilityInput() {
      const present = status().filter(isPresent)
      if (present.length === 0) return null
      let sessions7d = 0
      try { const since = now() - SESSIONS_WINDOW_MS; sessions7d = opts.sessions().filter(s => s.last_event_at >= since).length } catch { sessions7d = 0 }
      return { sources: present.map(s => ({ source: s.source, health: s.health })), sessions7d }
    },
    install: (sources) => done(connectTerminalHooks(deps(), sources)),
    uninstall: (sources) => done(disconnectTerminalHooks(deps(), sources)),
  }
}
