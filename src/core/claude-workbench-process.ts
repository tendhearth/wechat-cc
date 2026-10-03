import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Options, SpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import { makeProcessTreeFreezer } from '../lib/process-tree-freeze'

interface ProcessRow { pid: number; parent: number; group: number }
const remaining = (deadline: number) => {
  const value = deadline - Date.now()
  if (value <= 0) throw new Error('claude_runtime_close_deadline')
  return value
}
const table = (deadline: number): ProcessRow[] => execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid='], { encoding: 'utf8', maxBuffer: 4_000_000, timeout: remaining(deadline), killSignal: 'SIGKILL' }).trim().split('\n').map(line => {
  const [pid, parent, group] = line.trim().split(/\s+/).map(Number)
  if (!pid || parent === undefined || group === undefined || !Number.isInteger(parent) || !Number.isInteger(group)) throw new Error('claude_runtime_process_table_invalid')
  return { pid, parent, group }
})
const alive = (target: number): boolean => {
  try { process.kill(target, 0); return true }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error }
}
const signal = (group: number, value: NodeJS.Signals) => {
  try { process.kill(-group, value) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
}

/** Claude's Bash children can own separate groups. Capture only descendants of
 * the public spawn-hook process, then verify every captured group has exited.
 * Freezing each owned group bounds new descendants while taking the snapshot.
 * Missing ancestry or an already-lost process cannot prove cleanup and rejects. */
export function ownClaudeWorkbenchProcess(stderr: Options['stderr']) {
  let child: ChildProcessWithoutNullStreams | undefined, exited = false, closing = false, terminated = false
  const groups = new Set<number>(), pids = new Set<number>()
  // 网络守护「暂停在跑的任务」(2026-10-03):冻住 / 放开整棵树。冻住期间要停 ⇒ terminate 直接
  // SIGKILL 冻住的那些组(绝不先放开),close 不再要求进程还活着。
  const freezer = makeProcessTreeFreezer(() => (child && !exited && !closing ? child.pid : undefined))
  return {
    freeze(): boolean { return !closing && !terminated && !!child?.pid && !exited && freezer.freeze() },
    thaw(): void { if (!terminated) freezer.thaw() },
    terminate(): void { terminated = true; freezer.kill() },
    spawn(options: SpawnOptions) {
      if (closing || child) throw new Error('claude_runtime_closed_or_duplicate_spawn')
      child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true, windowsHide: true, signal: options.signal })
      if (child.pid) { groups.add(child.pid); pids.add(child.pid) }
      child.on('exit', () => { exited = true })
      child.on('error', () => { if (!child?.pid) exited = true })
      child.stderr.on('data', chunk => stderr?.(String(chunk)))
      return child
    },
    prepareClose(deadline: number) {
      closing = true
      if (!child) return
      // 冻住时已经整棵杀掉:没有什么要再冻、也不再要求它活着(close 下面照样等它们全退)。
      if (terminated) return
      if (!child.pid || exited || !alive(child.pid)) throw new Error('claude_runtime_process_ownership_lost')
      signal(child.pid, 'SIGSTOP')
      for (let pass = 0; pass < 10; pass++) {
        const rows = table(deadline), owned = new Set<number>([child.pid])
        if (!rows.some(row => row.pid === child!.pid && row.group === child!.pid)) throw new Error('claude_runtime_process_ownership_lost')
        let changed = true
        while (changed) {
          remaining(deadline)
          changed = false
          for (const row of rows) if (owned.has(row.parent) && !owned.has(row.pid)) { owned.add(row.pid); changed = true }
          if (owned.size > 1024) throw new Error('claude_runtime_descendant_limit')
        }
        let added = false
        for (const row of rows) if (owned.has(row.pid)) {
          if (!groups.has(row.group)) {
            if (!owned.has(row.group)) throw new Error('claude_runtime_descendant_group_unowned')
            groups.add(row.group); signal(row.group, 'SIGSTOP'); added = true
          }
          if (!pids.has(row.pid)) { pids.add(row.pid); added = true }
        }
        if (!added) return
      }
      throw new Error('claude_runtime_descendants_not_frozen')
    },
    async close(deadline: number) {
      closing = true
      if (!child) return
      child.stdin.end()
      // Never resume a frozen descendant: a TERM handler could fork a fresh
      // detached group after the ownership snapshot and escape verification.
      if (terminated) {
        // 冻住时已经整棵 SIGKILL 过(登记在 freezer 里,含根组);这里只等它们全退。
        // 不走下面那条:僵尸组上 kill(-组) 在 macOS 报 EPERM,严格版 signal / alive 会把它当成错误。
        freezer.kill()
        while (!exited || freezer.alive()) {
          if (Date.now() >= deadline) { freezer.kill(); throw new Error('claude_runtime_process_not_exited') }
          await new Promise<void>(resolve => setTimeout(resolve, 15))
        }
        return
      }
      for (const group of groups) signal(group, 'SIGKILL')
      while (!exited || [...groups].some(group => alive(-group)) || [...pids].some(pid => alive(pid))) {
        if (Date.now() >= deadline) {
          for (const group of groups) signal(group, 'SIGKILL')
          throw new Error('claude_runtime_process_not_exited')
        }
        await new Promise<void>(resolve => setTimeout(resolve, 15))
      }
    },
  }
}
