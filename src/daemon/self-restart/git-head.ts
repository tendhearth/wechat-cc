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
 * 跑一条 git 命令并拿到它的 stdout。共享的超时 + 吞异常骨架。
 *
 * 返回 `null` 表示**没能问出结果**(不是 git 仓库、git 不在 PATH、超时、
 * 非零退出)。注意这与"命令成功但输出为空"是两回事 —— `git status
 * --porcelain` 在工作树干净时正是后者,所以这一层如实回传空串,由各个
 * 调用方自己决定空串怎么解读。
 */
async function gitCapture(args: string[], deps: GitRevParseDeps): Promise<string | null> {
  const spawn = deps.spawn ?? Bun.spawn
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  try {
    const proc = spawn(['git', ...args], {
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
      if (code === 'timeout') {
        try { proc.kill() } catch { /* best effort */ }
        // 主动丢弃管道:这是常驻进程,未消费的流要等 GC 才关。
        try { void proc.stdout?.cancel?.() } catch { /* best effort */ }
        return null
      }
      if (code !== 0) {
        try { void proc.stdout?.cancel?.() } catch { /* best effort */ }
        return null
      }
      return (await new Response(proc.stdout).text()).trim()
    } finally {
      if (timer) clearTimeout(timer)
    }
  } catch {
    return null
  }
}

/** `git rev-parse <revision>` —— 空输出与失败一样都当作"问不出来"。 */
async function gitRevParse(revision: string, deps: GitRevParseDeps): Promise<string | null> {
  const out = await gitCapture(['rev-parse', revision], deps)
  return out || null
}

/**
 * 工作树有没有未提交的改动(`git status --porcelain -uno`)。
 *
 * `'dirty' | 'clean' | null`,**null = 问不出来**,调用方必须当作 dirty。
 *
 * 为什么这条是必须的:本机制比的是 HEAD,而 bun 真正加载的是**工作树上的
 * 文件**。daemon 跑的又恰恰是主人日常开发的那个 checkout。于是"HEAD 动了"
 * 完全可能对应着 rebase 撞冲突撞到一半、或者刚 commit 完又在改 —— 磁盘上
 * 是半截状态。那样重启,新进程会因为解析失败起不来,而 launchd 的
 * KeepAlive + ThrottleInterval=10 会每 10 秒重试一次,**把 bot 彻底打下线,
 * 而且按"零界面"的要求一声不吭**。那个结果严格劣于继续跑旧代码 —— 正是
 * 这套机制存在的理由的反面。
 *
 * 用 `-uno`(忽略未跟踪文件)是刻意的:未跟踪文件不可能让 bun 解析失败,
 * 而仓库根下随手放一个临时文件就让这套机制终身失效,那是另一种失败。
 */
export async function readGitWorktreeDirty(deps: GitRevParseDeps): Promise<'dirty' | 'clean' | null> {
  const out = await gitCapture(['status', '--porcelain', '--untracked-files=no'], deps)
  if (out === null) return null
  return out === '' ? 'clean' : 'dirty'
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
