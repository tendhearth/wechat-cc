/**
 * git-head — 读 checkout 当前的 commit,以及(Task 3 review #2)HEAD 上
 * bun.lock 的 blob 哈希。
 *
 * 永不抛、永不挂:任何失败(不是 git 仓库、git 不在 PATH、超时、空输出)
 * 一律返回 null,由 stale-code 的"读不到就不动作"规则兜底。
 */

const DEFAULT_TIMEOUT_MS = 3_000

export interface GitRevParseDeps {
  cwd: string
  spawn?: typeof Bun.spawn
  timeoutMs?: number
}

/**
 * `git rev-parse <revision>`,共享的超时 + 吞异常骨架。两个导出函数
 * (readGitHead / readGitLockfileBlob)只是喂不同的 revision 参数。
 */
async function gitRevParse(revision: string, deps: GitRevParseDeps): Promise<string | null> {
  const spawn = deps.spawn ?? Bun.spawn
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  try {
    const proc = spawn(['git', 'rev-parse', revision], {
      cwd: deps.cwd,
      stdout: 'pipe',
      stderr: 'ignore',
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<'timeout'>(resolve => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs)
    })
    try {
      const code = await Promise.race([proc.exited, timedOut])
      if (code === 'timeout') { try { proc.kill() } catch { /* best effort */ } return null }
      if (code !== 0) return null
      const out = (await new Response(proc.stdout).text()).trim()
      return out || null
    } finally {
      if (timer) clearTimeout(timer)
    }
  } catch {
    return null
  }
}

export async function readGitHead(deps: GitRevParseDeps): Promise<string | null> {
  return gitRevParse('HEAD', deps)
}

/**
 * Blob hash of `bun.lock` as committed at HEAD (`git rev-parse HEAD:bun.lock`)
 * — Task 3 review finding #2. self-restart compares this at boot vs. at
 * check-time: if it moved, HEAD's dependency tree may not match what's
 * actually installed in node_modules yet (a manual `git pull` without a
 * following `bun install`), and restarting into that would crash-loop under
 * launchd's KeepAlive. Same "read failed ⇒ null ⇒ caller must not act"
 * contract as readGitHead — a repo with no committed `bun.lock`, a detached
 * worktree, or a timed-out git process all fail the SAME way readGitHead's
 * failures do.
 */
export async function readGitLockfileBlob(deps: GitRevParseDeps): Promise<string | null> {
  return gitRevParse('HEAD:bun.lock', deps)
}
