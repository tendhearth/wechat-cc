import { writeJsonAtomicAsync } from '../../lib/json-file'
import * as fs from 'node:fs/promises'
import { SAFE_GIT, preparationEnv, syncFilterOverrides, Preparation, type PreparationOptions } from './worktree-preparation'
import { refreshWorktreeRemotes, type FetchOptions } from './worktree-fetch'
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
 * 2026-10-20 规矩改了一处:仓库根 tendhearth.json 里的工作区脚本会跑 —— 但只跑主人当面批准过的那一份内容
 * (按仓库 + 内容哈希,改一个字就要重批),别的一律不跑。见 worktree-scripts.ts / service/scripts.ts;钩子照旧不跑。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { copyWorkspaceDependencies, readPreparationFile } from './worktree-dependencies'
import { restoreWorkspaceDependencies } from './worktree-dependency-cache'

export interface WorktreeStart { base: string; sha: string; notices: string[] }
export interface WorktreePlan { root: string; branch: string; taskPath: string; repoRoot: string; projectPath: string; stateDir?: string; /** 本地或远端跟踪分支;缺省 = 当前分支。 */ base?: string; start?: WorktreeStart }

const BRANCH_PREFIX = 'cc/'
const TIMEOUT_MS = 30_000

/**
 * ownerConfig:在主人自己的项目目录里动(合回项目)时读系统配置 —— Windows 的 git 默认在系统配置里开 core.autocrlf,
 * 不读的话主人用 CRLF 检出的文件全被当成「改过」,快进写进去的文件换行也和主人检出的不一致(2026-10-08 Windows CI 抓到)。
 */
/** 跑一条 git;非零退出抛 `worktree_git_failed`(stderr 头几行带上,只给日志)。 */
export function git(cwd: string, args: string[], opts: { ownerConfig?: boolean; input?: string } = {}): string {
  const deadline = Date.now() + TIMEOUT_MS
  let phase: 'filters' | 'command' = 'filters'
  try {
    const env = preparationEnv(opts.ownerConfig)
    // Slow Windows process startup must fit the same total deadline, rather
    // than failing an otherwise healthy command at a separate 5s probe limit.
    const filters = syncFilterOverrides(cwd, env, TIMEOUT_MS)
    phase = 'command'
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw Object.assign(Error('worktree_git_timeout'), { code: 'ETIMEDOUT' })
    return execFileSync('git', [...SAFE_GIT, ...filters, ...args], { cwd, env, encoding: 'utf8', timeout: remaining, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024, ...(opts.input !== undefined ? { input: opts.input } : { stdio: ['ignore', 'pipe', 'pipe'] }) }).trim()
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? '').trim().split('\n').slice(0, 3).join(' | ')
    // exitStatus:git 自己退出的码;超时被杀、起不来时没有 —— repoRootOrFail 靠它分「git 答了」和「这次没问成」,再看 stderr 判是不是仓库
    const status = (error as { status?: unknown }).status
    const timedOut = (error as { code?: unknown }).code === 'ETIMEDOUT' || (error as { signal?: unknown }).signal === 'SIGTERM'
    throw Object.assign(new Error('worktree_git_failed'), { detail: stderr, phase, ...(typeof status === 'number' ? { exitStatus: status } : {}), ...(timedOut ? { timedOut: true } : {}) })
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
 * git 说这里不是仓库的那句 stderr(gitEnv 定了 LC_ALL=C,措辞固定)。只认这一句:dubious ownership / safe.directory
 * 是「是仓库,但 git 不信任这个目录」,说成「不是 Git 仓库」是假话,走 worktree_git_failed 带原文(#537 评审)。
 */
export const NOT_A_REPO = /not a git repository/i

/**
 * 同上,但分清「git 说不是仓库」和「这次没问成」(10-21):机器很忙时 rev-parse 撞上超时,repoRootOf 会把它当成不是仓库,
 * 主人就收到一句假话「这个项目不是 Git 仓库」。这里:目录不在 / git 自己说了「不是仓库」(NOT_A_REPO)⇒ null;别的非零退出、
 * 成功却读回空 ⇒ 抛 worktree_git_failed 带原文;超时 ⇒ 直接抛 worktree_git_failed
 * (「git 操作没成功」)—— git() 是同步的,再等一轮 30 秒等于把整个 daemon 再堵 30 秒(#490 评审);起不来(EAGAIN / EMFILE 这类,
 * 几乎是瞬时的)⇒ 再问一次,还不行再抛。工作台建独立工作区用它;终端的权限闸门仍用 repoRootOf(读不到就当项目外,偏保守)。
 */
export function repoRootOrFail(projectPath: string): string | null {
  if (!existsSync(projectPath)) return null
  let last: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const top = git(projectPath, ['rev-parse', '--show-toplevel'])
      // 成功却读回空 ⇒ 不是「不是仓库」,是这次没读全;不能说成假话(10-22,CI 上偶发 worktree_not_git)
      if (!top) throw Object.assign(new Error('worktree_git_failed'), { detail: 'rev-parse returned empty output' })
      return real(top)
    } catch (error) {
      const e = error as { exitStatus?: unknown; detail?: unknown }
      // 只有 git 自己说了「不是仓库」才回 null(⇒ worktree_not_git);别的非零退出带着 stderr 抛 worktree_git_failed,
      // 主人看到的是「git 操作没成功」,日志里有原文 —— 以前任何退出码都当成「不是仓库」
      if (typeof e.exitStatus === 'number') {
        if (NOT_A_REPO.test(String(e.detail ?? ''))) return null
        throw error
      }
      if ((error as { timedOut?: unknown }).timedOut) throw error
      last = error
    }
  }
  throw last
}
/** Preparation must not block the daemon while discovering a repository. */
export async function repoRootOrFailAsync(projectPath: string, options: PreparationOptions = {}): Promise<string | null> {
  const budget = new Preparation(options)
  try {
    const top = (await budget.git(projectPath, ['rev-parse','--show-toplevel'])).trim()
    if (!top) throw Error('worktree_git_failed')
    return await fs.realpath(top)
  } catch (error) {
    if (NOT_A_REPO.test(String((error as {detail?:string}).detail ?? '')) || (error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
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

/**
 * 「从哪个分支开始」的名字(2026-10-08,对标 Paseo):只收本地分支名的安全子集 —— 字母数字和 `._/-`,
 * 不以 `-` / `/` / `.` 开头,不含 `..` / `//` / `@{`,不以 `/` / `.lock` 结尾,最长 200。拼不出选项或越界的 ref。
 */
export function validBaseBranch(name: unknown): name is string {
  return typeof name === 'string' && name.length > 0 && name.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name)
    && !name.includes('..') && !name.includes('//') && !name.endsWith('/') && !name.endsWith('.lock') && !name.endsWith('.')
}
/** 只解析分支,不接受 tag、表达式或选项。本地同名分支优先。 */
function baseRef(repoRoot: string, base: string): string | null {
  if (!validBaseBranch(base)) return null
  for (const ref of [`refs/heads/${base}`, `refs/remotes/${base}`]) {
    try { git(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]); return ref } catch { /* next */ }
  }
  return null
}
/** 这个本地或远端跟踪分支在不在。 */
export function baseBranchExists(repoRoot: string, base: string): boolean {
  return baseRef(repoRoot, base) !== null
}

/** Refresh first, then freeze a commit. A failed fetch never discards usable local work. */
export async function prepareWorktreeStart(repoRoot: string, base?: string, options: FetchOptions = {}): Promise<WorktreeStart> {
  const budget = new Preparation(options), notices: string[] = []
  try { await refreshWorktreeRemotes(repoRoot, options) }
  catch { if (options.signal?.aborted) throw Error('worktree_preparation_cancelled'); notices.push('获取远端更新失败或超时，使用本机已有提交；起点可能不是最新版本。') }
  const run = async (args: string[]) => (await budget.git(repoRoot, args)).trim()
  let ref: string | null = base === undefined ? 'HEAD' : null
  if (base !== undefined && validBaseBranch(base)) for (const candidate of [`refs/heads/${base}`, `refs/remotes/${base}`]) {
    try { await run(['rev-parse','--verify','--quiet',`${candidate}^{commit}`]); ref = candidate; break } catch { budget.check() }
  }
  if (!ref) throw Error('worktree_base_missing')
  let label = base ?? 'HEAD'
  if (base === undefined) try { label = await run(['symbolic-ref','--short','HEAD']) } catch { budget.check() }
  if (base === undefined || ref.startsWith('refs/heads/')) {
    try {
      const name = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
      const upstream = await run(['rev-parse','--symbolic-full-name',`${name}@{upstream}`])
      if (upstream.startsWith('refs/remotes/')) { await run(['merge-base','--is-ancestor',ref,upstream]); ref = upstream }
    } catch { budget.check() }
  }
  return { base: label, sha: await run(['rev-parse','--verify',`${ref}^{commit}`]), notices }
}

/** 算位置,不碰盘。projectId / id 都按格式校验,拼不出越界的路径。 */
export function planWorktree(input: { stateDir: string; projectId: string; projectPath: string; repoRoot: string; id: string; base?: string }): WorktreePlan {
  if (!PROJECT_ID.test(input.projectId) || !ID.test(input.id) || (input.base !== undefined && !validBaseBranch(input.base))) throw new Error('invalid_worktree')
  const repoRoot = real(input.repoRoot), projectPath = real(input.projectPath)
  const rel = relative(repoRoot, projectPath)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('invalid_worktree')
  const root = join(input.stateDir, 'worktrees', input.projectId, input.id)
  return { root, branch: `${BRANCH_PREFIX}${input.id}`, taskPath: rel ? join(root, rel) : root, repoRoot, projectPath: input.projectPath, stateDir: input.stateDir, ...(input.base !== undefined ? { base: input.base } : {}) }
}

/**
 * 建(幂等):目录已经是这个分支的工作区 ⇒ 直接用;目录不在 ⇒ `git worktree add -b <分支> <目录> HEAD`。
 * 分支已经存在(别处用过这个名字)⇒ 拒绝,不覆盖。返回任务目录(真实路径)。
 */
const preparations = new Map<string, Promise<unknown>>()
function serializeCheckout<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const previous = preparations.get(root) ?? Promise.resolve()
  const pending = previous.catch(() => {}).then(operation)
  preparations.set(root, pending)
  return pending.finally(() => { if (preparations.get(root) === pending) preparations.delete(root) })
}
export function ensureWorktree(plan: WorktreePlan, options: PreparationOptions = {}): Promise<string> {
  return serializeCheckout(plan.root, () => createWorktree(plan, options))
}
async function createWorktree(plan: WorktreePlan, options: PreparationOptions): Promise<string> {
  const budget = new Preparation(options)
  const run = async (cwd: string, args: string[]) => (await budget.git(cwd, args)).trim()
  budget.check()
  let created = false
  if (existsSync(plan.root)) {
    let branch = ''
    try { branch = await run(plan.root, ['rev-parse', '--abbrev-ref', 'HEAD']) } catch { /* 下面拒绝 */ }
    if (branch !== plan.branch) throw new Error('worktree_conflict')
  } else {
    try { await run(plan.repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${plan.branch}`]); throw Error('worktree_branch_exists') }
    catch (error) { budget.check(); if ((error as {exitStatus?:number}).exitStatus !== 1) throw error }
    plan.start ??= await prepareWorktreeStart(plan.repoRoot, plan.base, { ...options, timeoutMs: budget.deadline - Date.now() })
    await fs.mkdir(dirname(plan.root), { recursive: true, mode: 0o700 })
    await checkCheckoutBudget(budget, plan.repoRoot, plan.start.sha, dirname(plan.root))
    try {
      await run(plan.repoRoot, ['worktree', 'add', '-b', plan.branch, plan.root, plan.start.sha])
      created = true
      const record = resolve(plan.root, await run(plan.root, ['rev-parse', '--git-path', 'cc-worktree-start.json']))
      const save = () => writeJsonAtomicAsync(record, plan.start, { mode: 0o600 })
      await save()
      await copyIncludedFiles(plan.repoRoot, plan.root, { ...options, timeoutMs: Math.min(5000, budget.deadline - Date.now() - 250) })
      const dependencyOptions = { ...options, baseSha: plan.start.sha, timeoutMs: Math.min(15_000, budget.deadline - Date.now() - 250) }
      plan.start.notices.push(...await (plan.stateDir ? restoreWorkspaceDependencies(plan.repoRoot, plan.root, plan.stateDir, dependencyOptions) : copyWorkspaceDependencies(plan.repoRoot, plan.root, dependencyOptions)))
      budget.check()
      await save()
    } catch (error) {
      await discardCheckoutAsync(plan.repoRoot, plan.root)
      try { await new Preparation({timeoutMs:5000}).git(plan.repoRoot,['branch','-D',plan.branch]) } catch { /* only this invocation's new branch */ }
      throw error
    }
  }
  // Creation can precede task acceptance; retry must keep the original SHA and notices.
  if (!created) {
    try {
      const record = resolve(plan.root, await run(plan.root, ['rev-parse', '--git-path', 'cc-worktree-start.json']))
      const value = JSON.parse((await readPreparationFile(dirname(record), 'cc-worktree-start.json', 64 * 1024))!.toString()) as WorktreeStart
      if (typeof value.base === 'string' && /^[0-9a-f]{40,64}$/.test(value.sha) && Array.isArray(value.notices) && value.notices.every(n => typeof n === 'string')) plan.start = value
    } catch { /* legacy worktrees have no origin record */ }
  }
  if (!existsSync(plan.taskPath)) {
    // 基线分支上没有这个子项目:刚建的工作区和分支一并撤回,不留孤儿(2026-10-10)
    if (created) { await discardCheckoutAsync(plan.repoRoot, plan.root); try { await run(plan.repoRoot, ['branch', '-D', plan.branch]) } catch { /* 尽力 */ } }
    throw new Error('worktree_project_missing')
  }
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
export async function copyIncludedFiles(repoRoot: string, root: string, options: PreparationOptions = {}): Promise<number> {
  const budget = new Preparation(options)
  try { if (!await readPreparationFile(repoRoot, '.worktreeinclude', 1024 * 1024)) return 0 } catch { return 0 }
  let listed: string[], ignored: Set<string>
  try {
    listed = (await budget.git(repoRoot, ['ls-files', '-z', '--others', '--ignored', '--exclude-from=.worktreeinclude'])).split('\0').filter(Boolean)
    if (!listed.length) return 0
    ignored = new Set((await budget.git(repoRoot, ['check-ignore', '-z', '--stdin'], listed.join('\0') + '\0')).split('\0').filter(Boolean))
  } catch { return 0 }
  let files = 0, bytes = 0
  for (const rel of listed) {
    budget.check()
    if (rel.split('/').some(p => ['node_modules','.cc-tasks'].includes(p.toLowerCase())) || !ignored.has(rel) || rel.split('/').includes('..') || isAbsolute(rel)) continue
    const from = join(repoRoot, rel), to = join(root, rel)
    let st
    try { st = await fs.lstat(from) } catch { continue }
    if (!st.isFile() || existsSync(to)) continue
    if (files + 1 > INCLUDE_MAX_FILES || bytes + st.size > INCLUDE_MAX_BYTES) break
    try {
      if (!(await fs.realpath(from)).startsWith(repoRoot + sep)) continue
      await mkdirIncludedParent(root, dirname(rel))
      // 目标父目录不能借符号链接逃出工作区(HEAD 里某个目录是链接时)
      const parent = await fs.realpath(dirname(to)), base = await fs.realpath(root)
      if (parent !== base && !parent.startsWith(base + sep)) continue
      await fs.copyFile(from, to); files++; bytes += st.size
    } catch { /* 这一个跳过 */ }
  }
  return files
}

/** 这个工作区当前的提交号(40 位)。读不了 ⇒ 抛 `worktree_git_failed`,调用方自己决定吞不吞。 */
export function headSha(root: string): string {
  return git(root, ['rev-parse', '--verify', 'HEAD^{commit}'])
}

export async function headShaAsync(root: string, options: PreparationOptions = {}): Promise<string> { return (await new Preparation(options).git(root,['rev-parse','--verify','HEAD^{commit}'])).trim() }

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
  if (git(root, ['ls-files','-z','--',':(icase,glob)**/.cc-tasks/**'])) throw Error('invalid_task_environment')
  git(root, ['add', '-A', '--', '.', ':(exclude,icase,glob)**/.cc-tasks/**'])
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

/**
 * 重新打开(2026-10-08):工作区删了、分支还在 ⇒ 在原来的位置从这个分支重新检出,任务可以接着做。
 * 目录已经在 ⇒ `worktree_conflict`;分支没了(主人删过)⇒ `worktree_branch_missing`;分支上没有任务目录 ⇒ 撤回检出、
 * `worktree_project_missing`。照常带上 .worktreeinclude 的文件。
 */
export function reopenWorktree(repoRoot: string, root: string, branch: string, taskPath: string, options: PreparationOptions & { stateDir?: string; baseSha?: string } = {}): Promise<void> {
  return serializeCheckout(root, () => reopenCheckout(repoRoot, root, branch, taskPath, options))
}
async function reopenCheckout(repoRoot: string, root: string, branch: string, taskPath: string, options: PreparationOptions & { stateDir?: string; baseSha?: string }): Promise<void> {
  const budget = new Preparation(options)
  const run = async (args: string[]) => (await budget.git(repoRoot, args)).trim()
  budget.check()
  if (existsSync(root)) throw new Error('worktree_conflict')
  try { await run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]) } catch { throw new Error('worktree_branch_missing') }
  await run(['worktree', 'prune'])
  await fs.mkdir(dirname(root), { recursive: true, mode: 0o700 })
  await checkCheckoutBudget(budget, repoRoot, branch, dirname(root))
  try {
    await run(['worktree', 'add', root, branch])
    await copyIncludedFiles(repoRoot, root, { ...options, timeoutMs: Math.min(5000, budget.deadline - Date.now() - 250) })
    const dependencyOptions = { ...options, timeoutMs: Math.min(15_000, budget.deadline - Date.now() - 250) }
    await (options.stateDir ? restoreWorkspaceDependencies(repoRoot, root, options.stateDir, dependencyOptions) : copyWorkspaceDependencies(repoRoot, root, dependencyOptions))
    budget.check()
    if (!existsSync(taskPath)) throw Error('worktree_project_missing')
  } catch (error) { await discardCheckoutAsync(repoRoot, root); throw error }
}

/** 撤回刚做的检出:里面只有分支内容和 .worktreeinclude 复制进来的文件,没有用户的改动,所以 --force。尽力而为。 */
export async function discardCheckoutAsync(repoRoot: string, root: string): Promise<void> {
  const budget = new Preparation({ timeoutMs: 5000 })
  try { await budget.git(repoRoot, ['worktree', 'remove', '--force', root]) } catch { /* cleanup below */ }
  await fs.rm(root, { recursive: true, force: true })
  try { await budget.git(repoRoot, ['worktree', 'prune']) } catch { /* best effort */ }
}

/** 合并提示:主人自己在项目里跑。路径里有空格 / 引号时也安全地拼出来。 */
export function mergeHint(projectPath: string, branch: string): string {
  const quote = (s: string) => (/^[A-Za-z0-9._/@:-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)
  return `cd ${quote(projectPath)} && git merge ${quote(branch)}`
}

export const worktreeRootFor = (stateDir: string) => join(stateDir, 'worktrees') + sep


async function checkCheckoutBudget(budget: Preparation, repo: string, ref: string, destination: string): Promise<void> {
  const listing = await budget.git(repo, ['ls-tree','-r','-l','-z',ref,'--'])
  let count=0, bytes=0
  for (const entry of listing.split('\0').filter(Boolean)) {
    budget.check()
    if (++count>100_000) throw Error('worktree_checkout_entry_budget')
    const size=entry.slice(0,entry.indexOf('\t')).trim().split(/\s+/)[3]
    if (size && size !== '-') bytes+=Number(size)
    if (!Number.isFinite(bytes) || bytes>1024*1024*1024) throw Error('worktree_checkout_byte_budget')
  }
  const disk=await fs.statfs(destination)
  if (Number(disk.bavail)*Number(disk.bsize)<bytes+64*1024*1024) throw Error('worktree_checkout_space_budget')
}
async function mkdirIncludedParent(root: string, path: string): Promise<void> {
  let current=root
  for (const part of path.split(/[\\/]/).filter(p=>p && p!=='.')) {
    if (part==='..') throw Error('unsafe_include_directory')
    current=join(current,part)
    try { await fs.mkdir(current,{mode:0o700}) } catch (e) { if ((e as NodeJS.ErrnoException).code!=='EEXIST') throw e }
    const stat=await fs.lstat(current)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('unsafe_include_directory')
  }
}
