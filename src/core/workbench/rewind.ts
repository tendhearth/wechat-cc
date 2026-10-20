/**
 * 回到某一轮(回退设计稿切片 2,2026-10-21)的 git 部分。**全部同步**:执行段要原子(同 worktreeAction),
 * 一律不混进 checkpoints.ts 的异步调用(评审)。参数同 checkpoint:SAFE + 全局忽略 + 过滤器中和(checkpointGitArgs 给),
 * 不跑钩子、不跑过滤器、不读系统 / 全局配置;从不 reset --hard、clean。
 * 只碰 cwd 这个 linked worktree 的工作区、它自己的分支和它自己的 index。
 *
 * 切换 = 两树切换:临时 index `read-tree TB` → `update-index -q --refresh`(新读出来的 index 没有 stat 信息,不 refresh
 * 每个有差的路径都报 not uptodate;评审 2)→ `read-tree -m -u TB T`。ignored 与 .cc-workbench* 不在两棵树里 ⇒ 不碰;
 * 但 git 2.34 起会把 ignored 文件当成可覆盖 ⇒ 切换前 ignoredConflicts 先查(评审 6)。
 */
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { CHECKPOINT_REF_PREFIX, EXCLUDE, SAFE } from './checkpoints'
import { gitEnv } from './git-review'

/** root = 工作区根(--show-toplevel);filters = checkpointGitArgs 的 -c 参数;stateDir 放临时 index。 */
export interface RewindGit { root: string; filters: string[]; stateDir: string }
const TIMEOUT_MS = 120_000
const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/

export function git(g: RewindGit, args: string[], opts: { index?: string; input?: string; cwd?: string } = {}): Buffer {
  const env = opts.index ? { ...gitEnv(), GIT_INDEX_FILE: opts.index } : gitEnv()
  return execFileSync('git', [...SAFE, ...g.filters, ...args], { cwd: opts.cwd ?? g.root, env, maxBuffer: 64 * 1024 * 1024, timeout: TIMEOUT_MS, windowsHide: true, ...(opts.input !== undefined ? { input: opts.input } : { stdio: ['ignore', 'pipe', 'pipe'] }) })
}
const str = (g: RewindGit, args: string[], opts?: Parameters<typeof git>[2]) => git(g, args, opts).toString('utf8').trim()
const z = (bytes: Buffer) => bytes.toString('utf8').split('\0').filter(Boolean)

/** rev-parse --verify;不在 ⇒ null。 */
export function revParse(g: RewindGit, rev: string): string | null {
  try { const out = str(g, ['rev-parse', '--verify', '-q', rev]); return OID.test(out) ? out : null } catch { return null }
}
/** 一个 commit 的树与父;不是 commit / 不在 ⇒ null。 */
export function commitOf(g: RewindGit, commit: string): { tree: string; parents: string[] } | null {
  if (!OID.test(commit)) return null
  try {
    const body = git(g, ['cat-file', 'commit', commit]).toString('utf8')
    const header = body.slice(0, body.indexOf('\n\n'))
    const tree = /^tree ([0-9a-f]+)$/m.exec(header)?.[1]
    return tree ? { tree, parents: [...header.matchAll(/^parent ([0-9a-f]+)$/gm)].map(m => m[1]!) } : null
  } catch { return null }
}

export function tempIndex(g: RewindGit): string {
  const dir = join(g.stateDir, 'tmp')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return join(dir, `rw-${randomBytes(8).toString('hex')}.index`)
}
export function dropIndex(path: string): void {
  for (const p of [path, `${path}.lock`]) try { rmSync(p, { force: true }) } catch { /* 尽力 */ }
}
/** 刷新 stat:-q 下需要更新的条目照样往下走,退出码不算数。 */
function refresh(g: RewindGit, index?: string) {
  try { git(g, ['update-index', '-q', '--refresh'], index ? { index } : {}) } catch { /* 有差的路径本来就会报 */ }
}

/**
 * 工作区此刻的树(和 checkpoint 同一套:add -A,不收 .cc-workbench*,ignored 本来不进)。临时 index 从 seed 起、
 * 先 refresh 借 stat。返回树和那份 index(已经和磁盘对齐、带 stat;调用方用完 dropIndex)。
 */
export function workTree(g: RewindGit, seed: string): { tree: string; index: string } {
  const index = tempIndex(g)
  try {
    git(g, ['read-tree', seed], { index })
    refresh(g, index)
    git(g, ['add', '-A', '--', '.', ...EXCLUDE], { index })
    const tree = str(g, ['write-tree'], { index })
    if (!OID.test(tree)) throw new Error('rewind_git_failed')
    return { tree, index }
  } catch (error) { dropIndex(index); throw error }
}

/** a → b 的逐文件变化(A / D / M / T…),路径相对工作区根。 */
export function nameStatus(g: RewindGit, a: string, b: string): Array<{ status: string; path: string }> {
  const parts = z(git(g, ['diff-tree', '-r', '-z', '--no-renames', '--name-status', a, b]))
  const out: Array<{ status: string; path: string }> = []
  for (let i = 0; i + 1 < parts.length; i += 2) out.push({ status: parts[i]!, path: parts[i + 1]! })
  return out
}

/**
 * 切到 T 会覆盖的、被 ignore 的东西(评审 6):T 里有、TB 里没有、磁盘上却在的路径 —— 备份 B 里没有它,覆盖了就找不回。
 * 前缀是磁盘上的非目录且不在 TB 里(被 ignore 的文件挡在一个要建的目录上)也算。
 */
export function ignoredConflicts(g: RewindGit, target: string, backup: string): string[] {
  const added = nameStatus(g, backup, target).filter(e => e.status === 'A').map(e => e.path)
  if (!added.length) return []
  const tbFiles = new Set(z(git(g, ['ls-tree', '-r', '-z', '--name-only', backup])))
  const tbDirs = new Set<string>()
  for (const f of tbFiles) { const parts = f.split('/'); for (let i = 1; i < parts.length; i++) tbDirs.add(parts.slice(0, i).join('/')) }
  const out = new Set<string>()
  const stat = (rel: string) => { try { return lstatSync(join(g.root, rel)) } catch { return null } }
  for (const path of added) {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) {
      const prefix = parts.slice(0, i).join('/'), st = stat(prefix)
      if (st && !st.isDirectory() && !tbFiles.has(prefix)) out.add(prefix)
    }
    const st = stat(path)
    if (st && (!st.isDirectory() || !tbDirs.has(path))) out.add(path)
  }
  return [...out].sort()
}

/**
 * P..HEAD 里要被丢掉的提交(评审 9):merged = 有的已经在主人项目 HEAD 里(拒绝);elsewhere = 别的本地分支 / remote 里也有
 * (不丢数据,只提示)。projectHead 读不到 ⇒ 不判 merged。
 */
export function droppedCommits(g: RewindGit, parent: string, head: string, branch: string, projectHead: string | null): { count: number; merged: boolean; elsewhere: boolean } {
  const list = (args: string[]) => str(g, ['rev-list', ...args]).split('\n').filter(Boolean)
  const all = list([head, `^${parent}`])
  if (!all.length) return { count: 0, merged: false, elsewhere: false }
  const merged = !!projectHead && list([head, `^${parent}`, `^${projectHead}`]).length < all.length
  const short = branch.replace(/^refs\/heads\//, '')
  const elsewhere = list([head, `^${parent}`, '--not', `--exclude=${short}`, '--branches', '--remotes']).length < all.length
  return { count: all.length, merged, elsewhere }
}

/** linked worktree 的现场:git 目录、公共目录、HEAD 指向、有没有进行中的合并 / rebase / 锁。 */
export function worktreeState(g: RewindGit): { gitDir: string; commonDir: string; headRef: string | null; inProgress: string | null } {
  const real = (p: string) => { try { return realpathSync.native(p) } catch { return resolve(p) } }
  const [gitDir = '', commonDir = ''] = str(g, ['rev-parse', '--git-dir', '--git-common-dir']).split('\n').map(p => real(resolve(g.root, p.trim())))
  let headRef: string | null = null
  try { headRef = str(g, ['symbolic-ref', '-q', 'HEAD']) || null } catch { /* 游离 HEAD */ }
  let inProgress: string | null = null
  for (const name of ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'index.lock', 'HEAD.lock']) {
    if (existsSync(resolve(g.root, str(g, ['rev-parse', '--git-path', name])))) { inProgress = name; break }
  }
  return { gitDir, commonDir, headRef, inProgress }
}

/** 这件事现在还挂着 ref 的 checkpoint commit(审阅列表判「可回退」用);读不了 ⇒ null。 */
export function checkpointRefSet(root: string, taskId: string): Set<string> | null {
  try { return new Set(str({ root, filters: [], stateDir: '' }, ['for-each-ref', '--format=%(objectname)', `${CHECKPOINT_REF_PREFIX}${taskId}/`]).split('\n').filter(Boolean)) }
  catch { return null }
}

export function fileSha256(path: string): string | null {
  try { const st = lstatSync(path); if (!st.isFile()) return null; return createHash('sha256').update(readFileSync(path)).digest('hex') } catch { return null }
}

export type ApplyStep = 'backup' | 'switched' | 'branch' | 'verify'
export interface ApplyInput {
  g: RewindGit
  /** refs/heads/<分支>。 */
  branchRef: string
  oldHead: string
  target: { commit: string; tree: string; parent: string }
  backup: { commit: string; tree: string }
  backupRef: string
  /** 预检那份临时 index:从 TB 起、已和磁盘对齐(workTree 给的)。 */
  index: string
  /** 切过去之后的额外核对(快照列出的文件对 afterSha256);回不对的那个路径,null = 都对。 */
  verify?: () => string | null
  /** 测试注入:某一步之后抛,看回滚。 */
  inject?: (step: ApplyStep) => void
}
export type ApplyResult = { ok: true } | { ok: false; error: string; rolledBack: boolean }

/**
 * 执行段第 2–6 步(调用方先写好意图行、重查过前置):备份 ref → 两树切换 → CAS 挪分支 → 真 index 读 P → 校验。
 * 第 2 步之后任何失败 ⇒ 反向切回(分支 CAS 回旧 HEAD、真 index 原字节放回、工作区强制回到 TB)。
 */
export function applyRewind(input: ApplyInput): ApplyResult {
  const { g, target, backup } = input
  const realIndex = resolve(g.root, str(g, ['rev-parse', '--git-path', 'index']))
  let realCopy: string | null = null, touched = false, moved = false, step = 'backup'
  try {
    if (revParse(g, input.backupRef)) throw new Error('rewind_backup_exists')
    git(g, ['update-ref', input.backupRef, backup.commit])
    input.inject?.('backup')
    if (existsSync(realIndex)) { realCopy = tempIndex(g); copyFileSync(realIndex, realCopy) }
    step = 'switch'; touched = true
    git(g, ['read-tree', '-m', '-u', backup.tree, target.tree], { index: input.index })
    input.inject?.('switched')
    step = 'branch'
    git(g, ['update-ref', input.branchRef, target.parent, input.oldHead]); moved = true
    git(g, ['read-tree', target.parent])
    refresh(g)
    input.inject?.('branch')
    step = 'verify'
    const now = workTree(g, target.tree)
    dropIndex(now.index)
    if (now.tree !== target.tree) throw new Error('rewind_verify_tree')
    const bad = input.verify?.()
    if (bad) throw new Error('rewind_verify_file')
    input.inject?.('verify')
    if (realCopy) dropIndex(realCopy)
    return { ok: true }
  } catch (error) {
    const code = error instanceof Error && /^rewind_/.test(error.message) ? error.message : `rewind_${step}_failed`
    const rolledBack = rollback({ g, branchRef: input.branchRef, oldHead: input.oldHead, parent: target.parent, from: target.tree, to: backup.tree, moved, touched, realIndex, realCopy })
    if (realCopy) dropIndex(realCopy)
    return { ok: false, error: code, rolledBack }
  }
}

/** 反向切回:分支 CAS 回旧 HEAD,真 index 原字节放回,工作区从 from 强制回到 to(只动两树不同的路径)并核对。 */
export function rollback(input: { g: RewindGit; branchRef: string; oldHead: string; parent: string; from: string; to: string; moved: boolean; touched: boolean; realIndex?: string; realCopy?: string | null }): boolean {
  const { g } = input
  try {
    if (input.moved) git(g, ['update-ref', input.branchRef, input.oldHead, input.parent])
    if (input.realIndex && input.realCopy) copyFileSync(input.realCopy, input.realIndex)
    else if (input.moved) git(g, ['read-tree', input.oldHead])
    if (input.touched) {
      const index = tempIndex(g)
      try {
        git(g, ['read-tree', input.from], { index })
        git(g, ['read-tree', '--reset', '-u', input.to], { index })
      } finally { dropIndex(index) }
      const now = workTree(g, input.to)
      dropIndex(now.index)
      if (now.tree !== input.to) return false
    }
    return true
  } catch { return false }
}

/**
 * 开机对账(评审 4):意图行还是 applying ⇒ 看现场落在哪一格。
 * untouched = 分支是旧 HEAD、工作区是 TB(什么都没发生 / 已经回滚);applied = 分支是 P、工作区是 T(只差记账);
 * files_only = 工作区已是 T、分支没挪;branch_only = 分支挪了、工作区还是 TB;unknown = 都对不上(停住,让主人看)。
 */
export type Reconcile = 'untouched' | 'applied' | 'files_only' | 'branch_only' | 'unknown'
export function inspectApplying(g: RewindGit, input: { branchRef: string; priorHead: string; target: { tree: string; parent: string }; backupTree: string }): Reconcile {
  const head = revParse(g, input.branchRef)
  const now = workTree(g, input.target.tree)
  dropIndex(now.index)
  if (head === input.target.parent && now.tree === input.target.tree) return 'applied'
  if (head === input.priorHead && now.tree === input.backupTree) return 'untouched'
  if (head === input.priorHead && now.tree === input.target.tree) return 'files_only'
  if (head === input.target.parent && now.tree === input.backupTree) return 'branch_only'
  return 'unknown'
}
