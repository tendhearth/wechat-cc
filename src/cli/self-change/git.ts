/**
 * git.ts —— 流水线唯一碰 git 的地方。
 *
 * 为什么要单独包一层:每个步骤都要跑十几条 git,而这些 git 跑在一个
 * **执行者刚刚动过的克隆**里 —— 不能被仓库里的 hook、fsmonitor、
 * 半开的凭据提示挂住。所以统一:
 *  · `--no-pager` / `GIT_PAGER=cat`:CI 与 launchd 下没有 tty,分页器会直接吊死。
 *  · `core.hooksPath=<空设备>`:克隆里不跑任何 hook(husky 之类会改 HEAD)。
 *  · `GIT_TERMINAL_PROMPT=0`:凭据不对时立刻失败,不要在后台进程里等人输密码。
 *  · `LC_ALL=C`:输出给机器读(rev-list --count 之类),别被本地化。
 *  · env 里 `GIT_*` 先清干净(照 core/workbench/git-review.ts 的 gitEnv):
 *    调用方自己可能就跑在一次 rebase / commit 的钩子里,继承来的 GIT_DIR、
 *    GIT_INDEX_FILE 会让这里的每条命令都打到**别人的仓库**上。
 *
 * 和 git-review.ts 的 gitEnv 有一处**故意不同**:这里不设
 * `GIT_CONFIG_GLOBAL=/dev/null` / `GIT_CONFIG_NOSYSTEM=1`。git-review 只读,
 * 这里要 `push`(要全局配置里的 credential.helper)和 `commit`(要 user.name /
 * user.email)。全局配置里没有身份时由 commitAll 自己兜底。
 */
import { spawnSync } from 'node:child_process'

export interface GitResult {
  code: number | null
  stdout: string
  stderr: string
}

export interface Git {
  run(args: string[], opts?: { cwd?: string; timeoutMs?: number }): GitResult
}

/** node 的 spawnSync 有一堆重载,注入口取窄的这一份(假件好写)。 */
export type GitSpawnSync = (
  cmd: string,
  args: string[],
  opts: {
    cwd: string
    env: NodeJS.ProcessEnv
    encoding: 'utf8'
    timeout: number
    maxBuffer: number
    windowsHide: true
  },
) => { status: number | null; stdout: string | null; stderr: string | null; error?: Error }

/** 单条 git 的缺省上限。clone / fetch / push 由调用方显式放宽。 */
export const DEFAULT_GIT_TIMEOUT_MS = 120_000
/** `git diff` 在大改动上能打出几十兆,默认 1 MB 的 maxBuffer 会把输出**悄悄截断**。 */
const MAX_BUFFER = 64 * 1024 * 1024

const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null'

/** 每条命令都带的那几个开关(见文件头)。 */
const SAFE_ARGS: readonly string[] = [
  '--no-pager',
  '--no-optional-locks',
  '-c', 'core.fsmonitor=false',
  '-c', `core.hooksPath=${NULL_DEVICE}`,
]

export function gitEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key]
  return { ...env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' }
}

export function makeGit(spawn: GitSpawnSync, cwd: string, env: NodeJS.ProcessEnv = process.env): Git {
  return {
    run(args, opts) {
      const out = spawn('git', [...SAFE_ARGS, ...args], {
        cwd: opts?.cwd ?? cwd,
        env: gitEnv(env),
        encoding: 'utf8',
        timeout: opts?.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
      })
      // 起不来 / 超时:spawnSync 把原因放在 error 里,status 是 null。
      // 步骤代码只看 code,所以把原因搬到 stderr 上,不然失败报告里空无一物。
      if (out.error) {
        return { code: null, stdout: out.stdout ?? '', stderr: `${out.stderr ?? ''}${out.error.message}` }
      }
      return { code: out.status, stdout: out.stdout ?? '', stderr: out.stderr ?? '' }
    },
  }
}

/** 生产用的注入件。 */
export const nodeGitSpawnSync: GitSpawnSync = spawnSync as unknown as GitSpawnSync
