/**
 * git-head — 读 checkout 当前的 commit。
 *
 * 永不抛、永不挂:任何失败(不是 git 仓库、git 不在 PATH、超时、空输出)
 * 一律返回 null,由 stale-code 的"读不到就不动作"规则兜底。
 */

const DEFAULT_TIMEOUT_MS = 3_000

export async function readGitHead(deps: {
  cwd: string
  spawn?: typeof Bun.spawn
  timeoutMs?: number
}): Promise<string | null> {
  const spawn = deps.spawn ?? Bun.spawn
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  try {
    const proc = spawn(['git', 'rev-parse', 'HEAD'], {
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
