/**
 * 冻住 / 放开 / 杀掉一整棵进程树(网络守护「暂停在跑的任务」,主人 2026-10-03 拍板)。
 *
 * 用 SIGSTOP(不是 SIGTSTP —— 那个能被捕获、被忽略),恢复用 SIGCONT。执行者都是 `detached: true`
 * 起的进程组组长,但它们自己再开的东西(Claude 的 Bash、codex 的后台终端、MCP 子进程)可能
 * 另起进程组 —— 只冻根组会漏。所以和 claude-workbench-process.ts 的收尾同一个办法:先冻根组
 * (挡住新的 fork),再按 `ps` 的父子关系把后代找全,后代自己的组逐个冻;最多十遍,
 * 直到一遍下来没有新面孔。
 *
 * Windows 没有 SIGSTOP:`freeze()` 直接返回 false,调用方退回原来的停法(以后再上 NtSuspendProcess)。
 *
 * 不变式:**冻住的树只会被放开(网络恢复)或被杀掉(SIGKILL 对停住的进程照样生效)**,
 * 绝不为了「优雅收尾」先放开 —— 放开那一下它就会接着用不受保护的网络。
 */
import { execFileSync } from 'node:child_process'

export interface ProcessRow { pid: number; parent: number; group: number }

export interface ProcessTreeFreezer {
  /** 冻住整棵树。true = 冻住了;false = 做不到(win32 / 没有 pid / 进程已经没了)。重复调用无害。 */
  freeze(): boolean
  /** 放开冻住的那些组 / 进程。没冻过就什么都不做。 */
  thaw(): void
  /** SIGKILL 冻住时登记过的每一个组 / 进程(不先放开)。 */
  kill(): void
  /** 登记过的组 / 进程里还有没有活的。 */
  alive(): boolean
  readonly frozen: boolean
}

export interface ProcessTreeFreezerDeps {
  platform?: string
  /** 测试注入;缺省 `/bin/ps -axo pid=,ppid=,pgid=`。 */
  table?: () => ProcessRow[]
  /** 测试注入;缺省 process.kill。target 为负 = 进程组。 */
  signal?: (target: number, signal: NodeJS.Signals | 0) => void
}

const MAX_PASSES = 10
const MAX_DESCENDANTS = 1024

export function readProcessTable(): ProcessRow[] {
  return execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid='], { encoding: 'utf8', maxBuffer: 4_000_000, timeout: 2_000, killSignal: 'SIGKILL' })
    .trim().split('\n').flatMap(line => {
      const [pid, parent, group] = line.trim().split(/\s+/).map(Number)
      return pid && Number.isInteger(parent) && Number.isInteger(group) ? [{ pid, parent: parent!, group: group! }] : []
    })
}

export function makeProcessTreeFreezer(rootPid: () => number | undefined | null, deps: ProcessTreeFreezerDeps = {}): ProcessTreeFreezer {
  const platform = deps.platform ?? process.platform
  const table = deps.table ?? readProcessTable
  const send = deps.signal ?? ((target: number, sig: NodeJS.Signals | 0) => { process.kill(target, sig) })
  /** 冻住的进程组(组号);单独冻的进程(组不归我们的后代)。 */
  const groups = new Set<number>(), loose = new Set<number>()
  let frozen = false
  // 尽力而为、从不抛:ESRCH = 已经没了;EPERM = macOS 上整组只剩僵尸(还没被收)时 kill(-组) 的回答。
  const quiet = (target: number, sig: NodeJS.Signals) => {
    try { send(target, sig); return true }
    catch { return false }
  }
  const exists = (target: number) => {
    try { send(target, 0); return true }
    catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
  }
  return {
    get frozen() { return frozen },
    freeze() {
      if (frozen) return true
      if (platform === 'win32') return false
      const root = rootPid()
      if (!root || root <= 1) return false
      // 根是 detached 起的组长:先冻整组,新的 fork 就停在这里了。
      if (!quiet(-root, 'SIGSTOP')) return false
      groups.add(root)
      frozen = true
      try {
        for (let pass = 0; pass < MAX_PASSES; pass++) {
          const rows = table(), owned = new Set<number>([root])
          let changed = true
          while (changed) {
            changed = false
            for (const row of rows) if (owned.has(row.parent) && !owned.has(row.pid)) { owned.add(row.pid); changed = true }
            if (owned.size > MAX_DESCENDANTS) break
          }
          let added = false
          for (const row of rows) {
            if (!owned.has(row.pid)) continue
            if (groups.has(row.group) || loose.has(row.pid)) continue
            // 组长是我们的后代 ⇒ 整组都是它开的,冻整组;否则(后代挂在别人的组里)只冻它自己。
            if (owned.has(row.group)) { groups.add(row.group); quiet(-row.group, 'SIGSTOP') }
            else { loose.add(row.pid); quiet(row.pid, 'SIGSTOP') }
            added = true
          }
          if (!added) break
        }
      } catch { /* ps 读不出:至少根组已经冻住,后代组留给下一次收尾 */ }
      return true
    },
    thaw() {
      if (!frozen) return
      frozen = false
      // 先放后代、最后放根:根醒来时看到的子进程都已经在跑。
      for (const pid of loose) quiet(pid, 'SIGCONT')
      for (const group of [...groups].reverse()) quiet(-group, 'SIGCONT')
    },
    kill() {
      for (const group of groups) quiet(-group, 'SIGKILL')
      for (const pid of loose) quiet(pid, 'SIGKILL')
      frozen = false
    },
    alive() {
      return [...groups].some(group => exists(-group)) || [...loose].some(pid => exists(pid))
    },
  }
}
