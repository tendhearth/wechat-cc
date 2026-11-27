import { lstatSync, mkdirSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

const TIMEOUT_MS = 500
const EMPTY_STALE_MS = 30_000
const delay = new Int32Array(new SharedArrayBuffer(4))
const codeOf = (error: unknown) => (error as NodeJS.ErrnoException).code

function removeEmpty(path: string): void {
  try { rmdirSync(path) } catch { /* Another contender or an owner is there. */ }
}

function release(lock: string, owner: string): void {
  try { unlinkSync(owner) } catch { return }
  removeEmpty(lock)
}

function reap(lock: string): void {
  try {
    const stat = lstatSync(lock)
    if (!stat.isDirectory()) return
    const owners = readdirSync(lock)
    if (!owners.length && Date.now() - stat.mtimeMs >= EMPTY_STALE_MS) removeEmpty(lock)
    for (const name of owners) {
      const pid = Number(/^(\d+)(?:-[a-f0-9-]+)?$/.exec(name)?.[1])
      if (!Number.isSafeInteger(pid) || pid <= 0) continue
      try { process.kill(pid, 0) }
      catch (error) { if (codeOf(error) === 'ESRCH') release(lock, join(lock, name)) }
    }
  } catch { /* The directory can vanish between reads. */ }
}

/** Every participating writer holds the lock across read, validation and rename. */
export function withRulesFileLock<T>(path: string, edit: () => T): T {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const lock = path + '.lock'
  const owner = join(lock, `${process.pid}-${randomUUID()}`)
  const timeout = performance.now() + TIMEOUT_MS
  for (;;) {
    try {
      mkdirSync(lock, { mode: 0o700 })
    } catch (error) {
      if (codeOf(error) !== 'EEXIST') throw error
      reap(lock)
      if (performance.now() >= timeout) throw Error('规则文件正由另一个进程修改，请稍后再试')
      Atomics.wait(delay, 0, 0, 20)
      continue
    }
    try {
      // If an empty-directory reaper raced with mkdir, only the contender
      // with the sole marker may enter. A nonempty lock cannot be reaped
      // while its owner is alive.
      try { writeFileSync(owner, '', { flag: 'wx', mode: 0o600 }) }
      catch (error) {
        // A reaper removed the directory we just made: start over within the same budget.
        if (codeOf(error) !== 'ENOENT') throw error
        continue
      }
      const owners = readdirSync(lock)
      if (owners.length === 1 && owners[0] === owner.slice(lock.length + 1)) return edit()
    } finally { release(lock, owner) }
    if (performance.now() >= timeout) throw Error('规则文件正由另一个进程修改，请稍后再试')
  }
}
