/**
 * 独立工作区(2026-10-07,主人定位「取代 Paseo 这一层」的第一项:同一个项目并行做几件事)。
 * 设计稿 docs/superpowers/specs/2026-10-06-workbench-parallel-worktrees-design.md,按其推荐默认:
 *   - 工作区放在 CC 的状态目录 `<stateDir>/worktrees/<项目编号>/<8 位>`,不弄乱项目周围;
 *   - 分支 `cc/<8 位>`,起点是 HEAD(项目里没提交的改动不带进去 —— 界面要说);
 *   - 「提交到分支」由 CC 做(`git add -A` + `git commit`),合并留给主人;
 *   - 删工作区只删目录、分支保留;工作区里还有没提交的改动 ⇒ 拒绝。
 * 项目是仓库里的子目录(monorepo)时,工作区是整个仓库的,任务目录 = 工作区里同样的相对位置。
 *
 * git 一律:清掉继承的 GIT_* 环境、不读全局配置、不跑仓库钩子(无人值守时不执行仓库里的脚本;
 * 代价是 LFS 之类靠钩子的内容不会自动展开,设计稿已写明)。每条命令有超时。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'

export interface WorktreePlan { root: string; branch: string; taskPath: string; repoRoot: string; projectPath: string }

const BRANCH_PREFIX = 'cc/'
const TIMEOUT_MS = 30_000

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key]
  return { ...env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' }
}
const SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false']
/** 跑一条 git;非零退出抛 `worktree_git_failed`(stderr 头几行带上,只给日志)。 */
export function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', [...SAFE, ...args], { cwd, env: gitEnv(), encoding: 'utf8', timeout: TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? '').trim().split('\n').slice(0, 3).join(' | ')
    throw Object.assign(new Error('worktree_git_failed'), { detail: stderr })
  }
}

/** 这个项目目录在不在一个 git 工作树里;在 ⇒ 仓库根(真实路径)。不在 / 读不了 ⇒ null。 */
export function repoRootOf(projectPath: string): string | null {
  try {
    const top = git(projectPath, ['rev-parse', '--show-toplevel'])
    return top ? realpathSync(top) : null
  } catch { return null }
}

const ID = /^[a-f0-9]{8}$/
const PROJECT_ID = /^p-[a-f0-9]{20}$/

/** 算位置,不碰盘。projectId / id 都按格式校验,拼不出越界的路径。 */
export function planWorktree(input: { stateDir: string; projectId: string; projectPath: string; repoRoot: string; id: string }): WorktreePlan {
  if (!PROJECT_ID.test(input.projectId) || !ID.test(input.id)) throw new Error('invalid_worktree')
  const rel = relative(input.repoRoot, input.projectPath)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('invalid_worktree')
  const root = join(input.stateDir, 'worktrees', input.projectId, input.id)
  return { root, branch: `${BRANCH_PREFIX}${input.id}`, taskPath: rel ? join(root, rel) : root, repoRoot: input.repoRoot, projectPath: input.projectPath }
}

/**
 * 建(幂等):目录已经是这个分支的工作区 ⇒ 直接用;目录不在 ⇒ `git worktree add -b <分支> <目录> HEAD`。
 * 分支已经存在(别处用过这个名字)⇒ 拒绝,不覆盖。返回任务目录(真实路径)。
 */
export function ensureWorktree(plan: WorktreePlan): string {
  if (existsSync(plan.root)) {
    let branch = ''
    try { branch = git(plan.root, ['rev-parse', '--abbrev-ref', 'HEAD']) } catch { /* 下面拒绝 */ }
    if (branch !== plan.branch) throw new Error('worktree_conflict')
  } else {
    try { git(plan.repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${plan.branch}`]); throw new Error('worktree_branch_exists') }
    catch (error) { if ((error as Error).message === 'worktree_branch_exists') throw error }
    mkdirSync(dirname(plan.root), { recursive: true, mode: 0o700 })
    git(plan.repoRoot, ['worktree', 'add', '-b', plan.branch, plan.root, 'HEAD'])
  }
  if (!existsSync(plan.taskPath)) throw new Error('worktree_project_missing')
  return realpathSync(plan.taskPath)
}

/** 工作区里有没有没提交的改动(含未跟踪的文件)。 */
export function worktreeDirty(root: string): boolean {
  return git(root, ['status', '--porcelain', '--untracked-files=normal']).length > 0
}

/**
 * 提交到分支:没有改动 ⇒ `{committed:false}`;有 ⇒ `git add -A` + `git commit`,返回提交号。
 * 作者用仓库自己的配置(读不到就用 CC 的名字,不让提交因为没配 user.name 失败)。
 */
export function commitWorktree(root: string, message: string): { committed: boolean; sha: string } {
  if (!worktreeDirty(root)) return { committed: false, sha: git(root, ['rev-parse', 'HEAD']) }
  git(root, ['add', '-A'])
  let identity: string[] = []
  try { git(root, ['config', 'user.email']) } catch { identity = ['-c', 'user.name=Tendhearth CC', '-c', 'user.email=cc@localhost'] }
  git(root, [...identity, 'commit', '--no-verify', '-m', message.slice(0, 200) || 'CC 的改动'])
  return { committed: true, sha: git(root, ['rev-parse', 'HEAD']) }
}

/** 删工作区目录(分支保留)。有没提交的改动 ⇒ `worktree_dirty`,不删。目录已经不在 ⇒ 只清 git 的登记。 */
export function removeWorktree(repoRoot: string, root: string): void {
  if (existsSync(root)) {
    if (worktreeDirty(root)) throw new Error('worktree_dirty')
    git(repoRoot, ['worktree', 'remove', root])
  } else {
    git(repoRoot, ['worktree', 'prune'])
  }
}

/** 合并提示:主人自己在项目里跑。路径里有空格 / 引号时也安全地拼出来。 */
export function mergeHint(projectPath: string, branch: string): string {
  const quote = (s: string) => (/^[A-Za-z0-9._/@:-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)
  return `cd ${quote(projectPath)} && git merge ${quote(branch)}`
}

export const worktreeRootFor = (stateDir: string) => join(stateDir, 'worktrees') + sep
