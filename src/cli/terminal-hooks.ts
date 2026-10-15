/**
 * terminal-hooks.ts — 「把终端里的 Claude Code / Codex / Cursor 接到 CC 上」的一份实现(2026-10-14;Cursor 10-15)。
 *
 * 终端会话只经 hooks 才到得了 CC(登记处、手机列表、推送、微信「终端」「日报」全靠它),以前只有
 * `wechat-cc hook install` 一个入口,新用户根本不知道。现在三处共用这里:
 *   - CLI `wechat-cc hook install|uninstall|status`(commands/hook.ts);
 *   - daemon 的 `POST /v1/cli/hooks/install|uninstall`(桌面「CC 现在怎么样」与引导页的「接上」/「修复」);
 *   - 「CC 现在怎么样」里那一行的状态判定。
 *
 * 写的命令行永远出自 selfHookCommand(= hookCommandLine + 当前进程自己的位置),CLI 和 daemon
 * 写出来的逐字一样。只动带自家标记的条目(hook.ts installHooks / uninstallHooks),别人的 hook 原样保留。
 * 绝不自动装:只有 CLI 命令或主人在桌面上点了确认才调 connectTerminalHooks。
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { CLI_ENTRY } from './repo-root'
import { isCompiledBundle } from '../lib/runtime-info'
import { defaultLocate } from '../core/cli-upgrade/locate'
import { claudeSettingsPath, codexHooksPath, cursorHooksPath, hookCommandLine, hookStatus, installHooks, uninstallHooks, type HookSource } from './hook'

export const HOOK_SOURCES: readonly HookSource[] = ['claude', 'codex', 'cursor']

/** 写进 hook 的命令行指向谁:编译包 = sidecar 自己;源码模式 = bun + 仓库里的 cli.ts。 */
export interface HookSelf { execPath: string; compiled: boolean; cliEntry: string }

export function defaultHookSelf(): HookSelf {
  return { execPath: process.execPath, compiled: isCompiledBundle(), cliEntry: CLI_ENTRY }
}

/** 这一份进程该写进 hook 的命令行(CLI `hook install` 与 daemon 路由共用)。 */
export function selfHookCommand(source: HookSource, self: HookSelf = defaultHookSelf()): string {
  return hookCommandLine({ ...self, source })
}

export function hookFileFor(source: HookSource, home: string, env: Record<string, string | undefined>): string {
  return source === 'claude' ? claudeSettingsPath(home) : source === 'cursor' ? cursorHooksPath(home) : codexHooksPath(home, env)
}

export interface TerminalHooksDeps {
  home: string
  env: Record<string, string | undefined>
  self: HookSelf
  /** 主人装的 CLI 在哪(与 provider 注册、CLI 自动升级找的是同一个);没装 ⇒ null。 */
  locate: (source: HookSource) => string | null
  exists: (p: string) => boolean
}

export function defaultTerminalHooksDeps(): TerminalHooksDeps {
  return { home: homedir(), env: process.env, self: defaultHookSelf(), locate: (s) => defaultLocate(s), exists: existsSync }
}

/**
 * missing = 没装;stale = 装了但命令行里的程序 / 脚本已经不在(多半是 app 搬过家、改过名,或者删掉的源码目录);
 * ok = 装了且指得到东西(可能指向另一份安装,比如开发机上的源码 checkout —— 能用就不算坏)。
 */
export type HookHealth = 'missing' | 'stale' | 'ok'

export interface HookSourceState {
  source: HookSource
  /** CLI 的位置;null = 没找到。 */
  cli: string | null
  file: string
  installed: boolean
  command: string | null
  health: HookHealth
  /** 命令行和这份进程会写的一模一样。 */
  matchesSelf: boolean
}

/** 命令行里带引号的绝对路径(程序本身,源码模式还有 cli.ts)。 */
export function commandPaths(command: string): string[] {
  const out: string[] = []
  for (const m of command.matchAll(/"([^"]+)"/g)) if (isAbsolute(m[1]!)) out.push(m[1]!)
  return out
}

export function hookHealth(st: { installed: boolean; command: string | null }, exists: (p: string) => boolean): HookHealth {
  if (!st.installed) return 'missing'
  if (!st.command) return 'stale'
  return commandPaths(st.command).every(p => exists(p)) ? 'ok' : 'stale'
}

export function readTerminalHooks(deps: TerminalHooksDeps): HookSourceState[] {
  return HOOK_SOURCES.map(source => {
    const file = hookFileFor(source, deps.home, deps.env)
    const st = hookStatus(file, source)
    let cli: string | null = null
    try { cli = deps.locate(source) } catch { cli = null }
    // Cursor 的 IDE 自己也触发 ~/.cursor/hooks.json:没装 cursor-agent、只有 IDE 也算「有」(cli 记成那个目录)。
    if (!cli && source === 'cursor') { const dir = join(deps.home, '.cursor'); if (deps.exists(dir)) cli = dir }
    return { source, cli, file, installed: st.installed, command: st.command, health: hookHealth(st, deps.exists), matchesSelf: st.command === selfHookCommand(source, deps.self) }
  })
}

/** 这台机上「有」这一家:CLI 找得到,或者已经装过 hook(daemon 的 PATH 可能比终端窄)。 */
export function isPresent(s: Pick<HookSourceState, 'cli' | 'installed'>): boolean {
  return s.cli !== null || s.installed
}

export interface HookChange {
  source: HookSource
  ok: boolean
  file: string
  changed?: boolean
  removed?: number
  command?: string
  error?: string
  /** 没装这个 CLI,所以没动它的配置。 */
  skipped?: 'cli_not_found'
}

/**
 * 接上。sources 缺省 ⇒ 这台机上有、而且没接好(missing / stale)的那几家;点名的 ⇒ 只要这台机上有就(重)写。
 * 幂等:已经是这份命令行就不写文件(changed:false)。
 */
export function connectTerminalHooks(deps: TerminalHooksDeps, sources?: readonly HookSource[]): HookChange[] {
  const states = readTerminalHooks(deps)
  const targets = sources
    ? states.filter(s => sources.includes(s.source))
    : states.filter(s => isPresent(s) && s.health !== 'ok')
  return targets.map(s => {
    if (!isPresent(s)) return { source: s.source, ok: false, file: s.file, skipped: 'cli_not_found' }
    const command = selfHookCommand(s.source, deps.self)
    try {
      const { changed } = installHooks(s.file, s.source, command)
      return { source: s.source, ok: true, file: s.file, changed, command }
    } catch (err) {
      return { source: s.source, ok: false, file: s.file, error: err instanceof Error ? err.message : String(err) }
    }
  })
}

/** 撤掉:只删自家条目;缺省三家都撤。幂等。 */
export function disconnectTerminalHooks(deps: TerminalHooksDeps, sources: readonly HookSource[] = HOOK_SOURCES): HookChange[] {
  return sources.map(source => {
    const file = hookFileFor(source, deps.home, deps.env)
    try {
      const r = uninstallHooks(file, source)
      return { source, ok: true, file, changed: r.changed, removed: r.removed }
    } catch (err) {
      return { source, ok: false, file, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
