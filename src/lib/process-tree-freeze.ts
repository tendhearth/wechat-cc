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
import { spawn, type ChildProcess } from 'node:child_process'

export interface ProcessRow { pid: number; parent: number; group: number }

export interface ProcessTreeFreezer {
  /** 冻住整棵树。true = 冻住了;false = 做不到,已登记的目标仍可 kill()。重复调用无害。 */
  freeze(): Promise<boolean>
  /** 放开冻住的那些组 / 进程。没冻过就什么都不做。 */
  thaw(): void
  /** 等在途扫描后 SIGKILL 已发现的目标。返回是否确认了扫描覆盖。 */
  kill(): Promise<boolean>
  /** 登记过的组 / 进程里还有没有活的。 */
  alive(): boolean
  readonly frozen: boolean
  readonly fullyFrozen: boolean
}

export interface ProcessTreeFreezerDeps {
  platform?: string
  /** 测试注入;缺省 `/bin/ps -axo pid=,ppid=,pgid=`。 */
  table?: () => ProcessRow[] | null | Promise<ProcessRow[] | null>
  /** 测试注入;缺省 process.kill。target 为负 = 进程组。 */
  signal?: (target: number, signal: NodeJS.Signals | 0) => void
}

const MAX_PASSES = 10
const MAX_DESCENDANTS = 1024

const TABLE_TIMEOUT_MS = 2_000
let tableChild: ChildProcess | undefined
let tableRead: Promise<ProcessRow[] | null> | undefined
/** performance.now() at the moment the in-flight ps was spawned. */
let tableStartedAt = -Infinity

/**
 * `freshAfter`(performance.now() 时刻):只接受在这之后才开始的快照。冻住一个组之后再读表,
 * 必须是冻住之后起的 ps —— 冻之前就在跑的那份共享结果可能漏掉冻前一刻刚开的进程组。
 */
export async function readProcessTable(timeoutMs = TABLE_TIMEOUT_MS, freshAfter = -Infinity): Promise<ProcessRow[] | null> {
  if (tableRead) {
    if (tableStartedAt >= freshAfter) return tableRead
    const started = performance.now()
    await tableRead
    const left = timeoutMs - (performance.now() - started)
    return left > 0 ? readProcessTable(left, freshAfter) : null
  }
  // Keep the handle of an abandoned ps until the runtime observes its exit.
  // A kernel-stuck process can survive even SIGKILL.
  if (tableChild?.pid && tableChild.exitCode == null && tableChild.signalCode == null) return Promise.resolve(null)
  let child
  try {
    child = spawn('/bin/ps', ['-axo', 'pid=,ppid=,pgid='], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
  } catch { return Promise.resolve(null) }
  tableChild = child
  tableStartedAt = performance.now()
  const stdout = child.stdout
  tableRead = new Promise<ProcessRow[] | null>(resolve => {
    let settled = false, size = 0
    const chunks: Buffer[] = []
    const finish = (rows: ProcessRow[] | null, abandon = false) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (abandon) {
        stdout.destroy()
        child.unref()
        try { child.kill('SIGKILL') } catch { /* best effort */ }
      } else tableChild = undefined
      stdout.off('data', onData)
      stdout.off('error', onError)
      child.off('error', onError)
      child.off('close', onClose)
      chunks.length = 0
      tableRead = undefined
      resolve(rows)
    }
    const onData = (chunk: Buffer) => {
      size += chunk.length
      if (size > 4_000_000) finish(null, true)
      else chunks.push(chunk)
    }
    const onError = () => finish(null, true)
    const onClose = (code: number | null) => finish(code === 0 ? parseTable(Buffer.concat(chunks).toString('utf8')) : null)
    const timer = setTimeout(onError, timeoutMs)
    stdout.on('data', onData)
    stdout.on('error', onError)
    child.on('error', onError)
    child.on('close', onClose)
  })
  return tableRead
}

function parseTable(output: string): ProcessRow[] | null {
  if (!output?.trim()) return null
  const rows: ProcessRow[] = []
  for (const line of output.trim().split('\n')) {
    const [pid, parent, group] = line.trim().split(/\s+/).map(Number)
    if (!pid || parent === undefined || group === undefined || !Number.isInteger(parent) || !Number.isInteger(group)) return null
    rows.push({ pid, parent, group })
  }
  return rows
}

export function makeProcessTreeFreezer(rootPid: () => number | undefined | null, deps: ProcessTreeFreezerDeps = {}): ProcessTreeFreezer {
  const platform = deps.platform ?? process.platform
  const send = deps.signal ?? ((target: number, sig: NodeJS.Signals | 0) => { process.kill(target, sig) })
  /** 冻住的进程组(组号);单独冻的进程(组不归我们的后代)。 */
  const groups = new Set<number>(), loose = new Set<number>()
  let frozen = false, fullyFrozen = false, generation = 0
  // Keep discovered targets for SIGKILL and exit checks even when SIGSTOP fails.
  const targets = new Set<number>()
  let root: number | undefined
  let pending: Promise<boolean> | undefined
  let killing: Promise<boolean> | undefined

  /** 最近一次成功 SIGSTOP 的时刻;之后的每一遍扫描都要读在它之后起的表。 */
  let lastStopAt = -Infinity
  async function readBefore(deadline: number) {
    const remaining = deadline - performance.now()
    if (remaining <= 0) return null
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const reading = deps.table ? deps.table() : readProcessTable(remaining, lastStopAt)
      return await Promise.race([
        reading,
        new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), remaining) }),
      ])
    } finally { clearTimeout(timer) }
  }
  // 尽力而为、从不抛:ESRCH = 已经没了;EPERM = macOS 上整组只剩僵尸(还没被收)时 kill(-组) 的回答。
  const quiet = (target: number, sig: NodeJS.Signals) => {
    try { send(target, sig); return true }
    catch { return false }
  }
  const exists = (target: number) => {
    try { send(target, 0); return true }
    catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
  }
  async function scan(root: number, current: number, deadline: number): Promise<boolean> {
    try {
      for (let pass = 0; pass < MAX_PASSES; pass++) {
        const rows = await readBefore(deadline)
        if (!rows || current !== generation || !rows.some(row => row.pid === root && row.group === root)) return false
        const owned = new Set<number>([root])
        let changed = true
        while (changed) {
          changed = false
          for (const row of rows) if (owned.has(row.parent) && !owned.has(row.pid)) { owned.add(row.pid); changed = true }
          if (owned.size > MAX_DESCENDANTS) return false
        }
        let added = false, failed = false
        for (const row of rows) {
          if (!owned.has(row.pid)) continue
          if (groups.has(row.group) || loose.has(row.pid)) continue
          // 组长是我们的后代 ⇒ 整组都是它开的,冻整组;否则(后代挂在别人的组里)只冻它自己。
          const groupOwned = owned.has(row.group)
          const target = groupOwned ? -row.group : row.pid
          targets.add(target)
          if (!quiet(target, 'SIGSTOP')) { failed = true; continue }
          lastStopAt = performance.now()
          if (groupOwned) groups.add(row.group)
          else loose.add(row.pid)
          added = true
        }
        if (failed) return false
        if (!added) { fullyFrozen = true; return true }
      }
    } catch { /* 调用方按停止路径收掉已登记的进程。 */ }
    return false
  }
  return {
    get frozen() { return frozen },
    get fullyFrozen() { return fullyFrozen },
    async freeze() {
      if (killing) return false
      if (pending) return pending
      if (frozen) return fullyFrozen
      if (platform === 'win32') return false
      const pid = rootPid()
      if (!pid || pid <= 1) return false
      // 根是 detached 起的组长:先冻整组,新的 fork 就停在这里了。
      if (!quiet(-pid, 'SIGSTOP')) return false
      lastStopAt = performance.now()
      root = pid
      groups.clear(); loose.clear(); targets.clear()
      groups.add(pid); targets.add(-pid)
      frozen = true
      const current = ++generation
      pending = scan(pid, current, performance.now() + TABLE_TIMEOUT_MS)
      try { return await pending }
      finally { if (current === generation) pending = undefined }
    },
    thaw() {
      if (!frozen || killing) return
      frozen = fullyFrozen = false
      generation++; pending = undefined
      // 先放后代、最后放根:根醒来时看到的子进程都已经在跑。
      for (const pid of loose) quiet(pid, 'SIGCONT')
      for (const group of [...groups].reverse()) quiet(-group, 'SIGCONT')
    },
    kill() {
      if (killing) return killing
      const deadline = performance.now() + TABLE_TIMEOUT_MS
      killing = (async () => {
        // Preserve parent links until the current scan has settled. If it
        // failed, use the remaining stop budget to try again before killing.
        if (pending) await pending
        if (frozen && !fullyFrozen && root) await scan(root, generation, deadline)
        const complete = fullyFrozen
        for (const target of targets) quiet(target, 'SIGKILL')
        frozen = fullyFrozen = false
        generation++; pending = undefined
        return complete
      })()
      return killing
    },
    alive() {
      return [...targets].some(exists)
    },
  }
}
