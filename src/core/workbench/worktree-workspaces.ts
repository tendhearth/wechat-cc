/**
 * 独立工作区(2026-10-07,主人定位「取代 Paseo 这一层」的第一项:同一个项目并行做几件事)。
 * 设计稿 docs/superpowers/specs/2026-10-06-workbench-parallel-worktrees-design.md,按其推荐默认:
 *   - 工作区放在 CC 的状态目录 `<stateDir>/worktrees/<项目编号>/<8 位>`,不弄乱项目周围;
 *   - 分支 `cc/<8 位>`,起点是 HEAD(项目里没提交的改动不带进去 —— 界面要说);
 *   - 「提交到分支」由 CC 做(`git add -A` + `git commit`),合并留给主人;
 *   - 删工作区只删目录、分支保留;工作区里还有没提交的改动 ⇒ 拒绝;
 *   - 仓库根有 `.worktreeinclude` ⇒ 新工作区带上它列出的被忽略文件(见 copyIncludedFiles)。
 * 项目是仓库里的子目录(monorepo)时,工作区是整个仓库的,任务目录 = 工作区里同样的相对位置。
 *
 * git 一律:清掉继承的 GIT_* 环境、不读全局配置、不跑仓库钩子(无人值守时不执行仓库里的脚本;
 * 代价是 LFS 之类靠钩子的内容不会自动展开,设计稿已写明)。每条命令有超时。
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'

export interface WorktreePlan { root: string; branch: string; taskPath: string; repoRoot: string; projectPath: string }

const BRANCH_PREFIX = 'cc/'
const TIMEOUT_MS = 30_000

/**
 * ownerConfig:在主人自己的项目目录里动(合回项目)时读系统配置 —— Windows 的 git 默认在系统配置里开 core.autocrlf,
 * 不读的话主人用 CRLF 检出的文件全被当成「改过」,快进写进去的文件换行也和主人检出的不一致(2026-10-08 Windows CI 抓到)。
 */
function gitEnv(ownerConfig = false): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key]
  return { ...env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', ...(ownerConfig ? {} : { GIT_CONFIG_NOSYSTEM: '1' }), GIT_OPTIONAL_LOCKS: '0' }
}
const SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false']
/** 跑一条 git;非零退出抛 `worktree_git_failed`(stderr 头几行带上,只给日志)。 */
export function git(cwd: string, args: string[], opts: { ownerConfig?: boolean; input?: string } = {}): string {
  try {
    return execFileSync('git', [...SAFE, ...args], { cwd, env: gitEnv(opts.ownerConfig), encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, ...(opts.input !== undefined ? { input: opts.input } : { stdio: ['ignore', 'pipe', 'pipe'] }) }).trim()
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? '').trim().split('\n').slice(0, 3).join(' | ')
    throw Object.assign(new Error('worktree_git_failed'), { detail: stderr })
  }
}

/** 这个项目目录在不在一个 git 工作树里;在 ⇒ 仓库根(真实路径)。不在 / 读不了 ⇒ null。 */
export function repoRootOf(projectPath: string): string | null {
  try {
    const top = git(projectPath, ['rev-parse', '--show-toplevel'])
    return top ? real(top) : null
  } catch { return null }
}
/**
 * 同一个目录的唯一写法:git 在 Windows 上回 `C:/…` 正斜杠 + 长名,临时目录可能是 8.3 短名(`RUNNER~1`)——
 * 不归一的话 relative() 会算出 `..`,把一个好好的子目录当成越界(2026-10-07 Windows CI 抓到)。
 */
function real(path: string): string {
  try { return realpathSync.native(path) } catch { return realpathSync(path) }
}

const ID = /^[a-f0-9]{8}$/
const PROJECT_ID = /^p-[a-f0-9]{20}$/

/** 算位置,不碰盘。projectId / id 都按格式校验,拼不出越界的路径。 */
export function planWorktree(input: { stateDir: string; projectId: string; projectPath: string; repoRoot: string; id: string }): WorktreePlan {
  if (!PROJECT_ID.test(input.projectId) || !ID.test(input.id)) throw new Error('invalid_worktree')
  const repoRoot = real(input.repoRoot), projectPath = real(input.projectPath)
  const rel = relative(repoRoot, projectPath)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('invalid_worktree')
  const root = join(input.stateDir, 'worktrees', input.projectId, input.id)
  return { root, branch: `${BRANCH_PREFIX}${input.id}`, taskPath: rel ? join(root, rel) : root, repoRoot, projectPath: input.projectPath }
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
    copyIncludedFiles(plan.repoRoot, plan.root)
  }
  if (!existsSync(plan.taskPath)) throw new Error('worktree_project_missing')
  return real(plan.taskPath)
}

const INCLUDE_MAX_FILES = 1000
const INCLUDE_MAX_BYTES = 100 * 1024 * 1024
/**
 * 新工作区带上本地文件(2026-10-08,对标 Conductor / Claude Code 的同名约定):仓库根有 `.worktreeinclude`(gitignore 写法)时,
 * 把**既被 git 忽略、又被它列出**的文件(典型是 `.env`、本地证书)从项目复制进新工作区 —— 不然执行者一跑就缺配置。
 * 只复制、从不执行;符号链接跳过;已经存在的不覆盖;最多 1000 个文件 / 100 MB,超了就停(node_modules 这类请让执行者自己装)。
 * 返回复制了几个。读不了 / 没有这个文件 ⇒ 0,不拦建工作区。
 */
export function copyIncludedFiles(repoRoot: string, root: string): number {
  if (!existsSync(join(repoRoot, '.worktreeinclude'))) return 0
  let listed: string[], ignored: Set<string>
  try {
    listed = git(repoRoot, ['ls-files', '-z', '--others', '--ignored', '--exclude-from=.worktreeinclude']).split('\0').filter(Boolean)
    if (!listed.length) return 0
    ignored = new Set(git(repoRoot, ['check-ignore', '-z', '--stdin'], { input: listed.join('\0') + '\0' }).split('\0').filter(Boolean))
  } catch { return 0 }
  let files = 0, bytes = 0
  for (const rel of listed) {
    if (!ignored.has(rel) || rel.split('/').includes('..') || isAbsolute(rel)) continue
    const from = join(repoRoot, rel), to = join(root, rel)
    let st
    try { st = lstatSync(from) } catch { continue }
    if (!st.isFile() || existsSync(to)) continue
    if (files + 1 > INCLUDE_MAX_FILES || bytes + st.size > INCLUDE_MAX_BYTES) break
    try {
      mkdirSync(dirname(to), { recursive: true })
      // 目标父目录不能借符号链接逃出工作区(HEAD 里某个目录是链接时)
      const parent = real(dirname(to)), base = real(root)
      if (parent !== base && !parent.startsWith(base + sep)) continue
      copyFileSync(from, to); files++; bytes += st.size
    } catch { /* 这一个跳过 */ }
  }
  return files
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

/**
 * 合回项目(2026-10-08):只做快进,别的情况一律拒绝、交给主人 —— 合并冲突和项目里没提交的改动都是主人的判断。
 *   工作区还有没提交的 ⇒ `worktree_uncommitted`;项目目录有已跟踪文件没提交 ⇒ `project_dirty`;
 *   项目不在任何分支上 ⇒ `project_detached`;项目已经往前走、快进不了 ⇒ `worktree_not_ff`。
 * 分支早已在项目里(主人自己合过 / 没改动)⇒ `{merged:false}`,也算合进去了。返回项目当前分支名。
 */
export function mergeWorktree(repoRoot: string, root: string, branch: string): { merged: boolean; into: string } {
  if (worktreeDirty(root)) throw new Error('worktree_uncommitted')
  const owner = { ownerConfig: true }
  if (git(repoRoot, ['status', '--porcelain', '--untracked-files=no'], owner).length > 0) throw new Error('project_dirty')
  let into = ''
  try { into = git(repoRoot, ['symbolic-ref', '-q', '--short', 'HEAD'], owner) } catch { /* 下面拒绝 */ }
  if (!into) throw new Error('project_detached')
  const ancestor = (a: string, b: string) => { try { git(repoRoot, ['merge-base', '--is-ancestor', a, b], owner); return true } catch { return false } }
  if (ancestor(`refs/heads/${branch}`, 'HEAD')) return { merged: false, into }
  if (!ancestor('HEAD', `refs/heads/${branch}`)) throw new Error('worktree_not_ff')
  git(repoRoot, ['merge', '--ff-only', '--no-edit', `refs/heads/${branch}`], owner)
  return { merged: true, into }
}

/** 合并提示:主人自己在项目里跑。路径里有空格 / 引号时也安全地拼出来。 */
export function mergeHint(projectPath: string, branch: string): string {
  const quote = (s: string) => (/^[A-Za-z0-9._/@:-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)
  return `cd ${quote(projectPath)} && git merge ${quote(branch)}`
}

export const worktreeRootFor = (stateDir: string) => join(stateDir, 'worktrees') + sep
