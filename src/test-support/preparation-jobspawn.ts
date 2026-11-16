import { beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, rmdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const COMPILE_TIMEOUT_MS = 180_000
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/**
 * One cc-jobspawn.exe per source content, shared by every test file in the run.
 * Several Windows suites used to each `rustc -O` the same file in parallel; on a
 * loaded runner that contention pushed single compiles past 60s (spawnSync ETIMEDOUT).
 * Exported for the unit test; the lock is a directory (atomic mkdir), the result an atomic rename.
 */
export function sharedJobspawnBinary(source = 'scripts/jobspawn.rs', cacheRoot = join(tmpdir(), 'cc-jobspawn-cache'), compile = (src: string, out: string) => {
  execFileSync('rustc', ['--edition', '2021', '-O', src, '-o', out], { timeout: COMPILE_TIMEOUT_MS, stdio: 'pipe' })
}): string {
  const hash = createHash('sha256').update(readFileSync(source)).digest('hex').slice(0, 16)
  mkdirSync(cacheRoot, { recursive: true })
  const binary = join(cacheRoot, `cc-jobspawn-${hash}.exe`)
  if (existsSync(binary)) return binary
  const lock = `${binary}.lock`
  const deadline = Date.now() + COMPILE_TIMEOUT_MS + 10_000
  for (;;) {
    try { mkdirSync(lock) } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      if (existsSync(binary)) return binary
      // A holder that died leaves its lock behind; past the compile budget, take over.
      let stale = Date.now() > deadline
      try { stale ||= Date.now() - statSync(lock).mtimeMs > COMPILE_TIMEOUT_MS + 10_000 } catch { continue }
      if (!stale) { sleepSync(250); continue }
      try { rmdirSync(lock) } catch { /* someone else took over */ }
      continue
    }
    try {
      if (existsSync(binary)) return binary
      const temp = `${binary}.${process.pid}.${randomUUID()}.tmp.exe`
      try { compile(source, temp); renameSync(temp, binary) } finally { rmSync(temp, { force: true }) }
      return binary
    } finally { try { rmdirSync(lock) } catch { /* already gone */ } }
  }
}

/** Real Windows fetch tests need the same strict job wrapper as packaged CC. */
export function preparationJobspawnFixture(): void {
  if (process.platform !== 'win32') return
  const previous = process.env.WECHAT_CC_JOBSPAWN
  beforeAll(() => { process.env.WECHAT_CC_JOBSPAWN = sharedJobspawnBinary() }, COMPILE_TIMEOUT_MS + 20_000)
  afterAll(() => {
    if (previous === undefined) delete process.env.WECHAT_CC_JOBSPAWN; else process.env.WECHAT_CC_JOBSPAWN = previous
  })
}
