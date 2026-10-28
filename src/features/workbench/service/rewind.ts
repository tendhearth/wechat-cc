/**
 * rewind 域:回到某一轮(spec 2026-10-21-workbench-rewind-design,切片 2)。预览 + 令牌 → 执行(同步段)→ 撤销回退;
 * 开机对账卡在 applying 的意图行;ref 的保留期清理。git 细节在 ../rewind.ts(同步)与 ../checkpoints.ts(异步,只用来打备份 B)。
 * 前置一条不过就拒绝,不做「尽量」。只认独立工作区(linked worktree,在 <stateDir>/worktrees/ 下)。
 */
import { readFileSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isAbsolute, join, relative } from 'node:path'
import { readArtifactSnapshot } from '../../../adapters/workbench/artifacts'
import { branchExists, checkpointGitArgs, deleteCheckpointRefs, REWIND_REF_PREFIX, takeCheckpoint } from '../checkpoints'
import { GIT_REVIEW_MIME, type GitReview } from '../git-review'
import { parseGitReviewSnapshot } from '../review'
import { applyRewind, rollbackText, checkpointRefSet, commitOf, droppedCommits, dropIndex, fileSha256, git, ignoredConflicts, inspectApplying, nameStatus, revParse, workTree, worktreeState, type ApplyStep, type RewindGit } from '../rewind'
import { assertNotRewindBlocked, isRestoreRow, REWIND_PARK_NOTE_TAIL, RESTORE_PREFIX, isUndoRow, undoTargetId, type RewindRow } from '../../../adapters/store/workbench/rewind-store'
import { pathsConflict } from '../../../lib/claim-paths'
import type { StoredTask, WorktreeRecord } from '../../../adapters/store/workbench/store'
import type { ServiceCtx } from './ctx'
import type { Active } from './state'
import type { LifecycleDomain } from './lifecycle'
import type { ScriptsDomain } from './scripts'
import type { UntilDomain } from './until'
import type { ViewDomain } from './view'

export interface RewindOptions {
  /** 测试注入:执行段某一步之后抛,看回滚。 */
  inject?: (step: ApplyStep) => void
  /** 关安静会话时最多等多久(ms;缺省 closeTimeoutMs + 5 秒)。 */
  closeWaitMs?: number
}
export const REWIND_GOAL_REASON = '工作区回退过,要再检查请重新建'
export const REWIND_REBUILD_HINT = '被 ignore 的构建产物(dist/、node_modules 这类)不会跟着回退,用之前先重新构建。'
export const REWIND_REFS_NOTE = '回退点会带上没被 ignore 的未跟踪文件(草稿、乱放的凭据也算),挂在项目仓库的 refs/tendhearth/ 下:git log --all 看得见,push --mirror 会推出去。分支删了或归档 30 天后自动清,也可以用 wechat-cc doctor 清。'
export const REWIND_RETAIN_MS = 30 * 24 * 3600_000
const MAX_LISTED = 50
const DAY_MS = 24 * 3600_000

type Point = 'start' | 'end'
export interface RewindTarget { artifactId: string; to: Point }
interface Round { artifactId: string; n: number; createdAt: number; review: GitReview | null; discarded: boolean }
interface Scene { task: StoredTask; wt: WorktreeRecord; root: string; g: RewindGit; head: string; quietOwn?: Active }
export interface RewindPreview {
  token: string
  target: { artifactId: string; to: Point; round: number }
  /** 会被撤掉的轮次(旧 → 新)。 */
  discarded: Array<{ artifactId: string; round: number }>
  /** diff-tree T TB:要撤掉的改动(A = 那几轮新建的、回退后没了;D = 那几轮删的、回退后回来)。至多 50 个路径。 */
  files: { count: number; paths: Array<{ status: string; path: string }> }
  /** 最后一轮做完之后又有的改动(主人手改、检查输出这类):照样撤掉、先备份。null = 没法比。 */
  extraChanges: { count: number; paths: Array<{ status: string; path: string }> } | null
  droppedCommits: { count: number; elsewhere: boolean }
  ignoredUntouched: true
  rebuildHint: string
  refsNote: string
  session: 'none' | 'will_close'
  devServer: boolean
  goal: { status: string; willStop: boolean } | null
}
export interface RewindResult { rewindId: string; backupRef: string; head: string; discarded: string[] }
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

const fail = (code: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(code), extra)
const within = (parent: string, child: string) => { const rel = relative(parent, child); return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel)) }
const real = (p: string) => realpathSync.native(p)
const tokenOf = (input: { taskId: string; C: string; TB: string; HEAD: string; discardedIds: string[] }) => createHash('sha256').update(JSON.stringify(input)).digest('hex')
const listed = (rows: Array<{ status: string; path: string }>) => ({ count: rows.length, paths: rows.slice(0, MAX_LISTED) })
/** 「第 3–5 轮」/「第 2 轮」/「第 2、4 轮」。 */
function rangeText(ns: number[]): string {
  if (!ns.length) return ''
  const s = [...ns].sort((a, b) => a - b)
  const consecutive = s.every((n, i) => i === 0 || n === s[i - 1]! + 1)
  return s.length === 1 ? `第 ${s[0]} 轮` : consecutive ? `第 ${s[0]}–${s.at(-1)} 轮` : `第 ${s.join('、')} 轮`
}
const pointText = (n: number, to: Point) => to === 'end' ? `第 ${n} 轮结束时` : `第 ${n} 轮开始前`

export interface RewindDomains {
  lifecycle: Pick<LifecycleDomain, 'cancelRun'>
  scripts: Pick<ScriptsDomain, 'busy' | 'serving'>
  until: Pick<UntilDomain, 'checking' | 'stop'>
  /** 「自己那条会话安静着」才允许不收工就回退。 */
  view: Pick<ViewDomain, 'isReplied'>
}

export function makeRewindDomain(ctx: ServiceCtx, domains: RewindDomains, opts: RewindOptions = {}) {
  const { store, state } = ctx
  const { isReplied } = domains.view
  const inflight = new Set<string>()
  let ready: Promise<void> = Promise.resolve()
  let timers: Array<ReturnType<typeof setTimeout>> = []

  function note(id: string, text: string) { try { store.addEvent(id, 'system', text); ctx.hub.touched(id) } catch { /* 记不上不影响回退本身 */ } }
  function readReview(a: { mime: string; storagePath: string; sha256: string }): GitReview | null {
    if (a.mime !== GIT_REVIEW_MIME) return null
    try { return parseGitReviewSnapshot(readArtifactSnapshot(a.storagePath, ctx.stateDir, a.sha256)) } catch { return null }
  }
  /** 所有审阅轮(旧 → 新,从 1 数),带「已撤掉」。 */
  function rounds(id: string): Round[] {
    const discarded = store.rewinds.discarded(id)
    return store.artifacts(id).filter(a => a.mime === GIT_REVIEW_MIME).reverse().map((a, i) => ({ artifactId: a.id, n: i + 1, createdAt: a.createdAt, review: readReview(a), discarded: discarded.has(a.id) }))
  }

  /**
   * 前置 1–3(设计稿「前置」):独立工作区、分支、没有进行中的合并 / rebase / 锁、没人占着文件夹、没有别的动作在碰工作区。
   * allowQuietOwn:这件事自己那条已答复、安静的保留会话不算占着(调用方先关它再重查)。
   */
  function scene(id: string, filters: string[], allowQuietOwn: boolean, resolving = false): Scene {
    const task = store.get(id)
    if (task.archivedAt !== null) throw fail('workbench_archived')
    const wt = store.worktrees.get(id)
    if (!wt) throw fail('not_worktree')
    if (wt.removedAt !== null) throw fail('worktree_removed')
    let root: string
    try { root = real(wt.root) } catch { throw fail('rewind_unavailable', { reason: 'worktree_missing' }) }
    let base: string
    try { base = real(join(ctx.stateDir, 'worktrees')) } catch { throw fail('rewind_unavailable', { reason: 'not_isolated' }) }
    if (root === base || !within(base, root) || !within(root, task.path)) throw fail('rewind_unavailable', { reason: 'not_isolated' })
    // 回退停住(needs_owner)/ 开机还没对完账(applying)⇒ 先等主人拍板;拍板本身(resolving)只挡 applying
    if (resolving) { if (store.rewinds.blocking(id) === 'applying') throw fail('workbench_busy') }
    else assertNotRewindBlocked(store.rewinds, id)
    // 2. 没人占着文件夹
    if (task.error === 'writer_not_closed') throw fail('workbench_busy')
    const own = state.runsByTask.get(id)
    let quietOwn: Active | undefined
    for (const holder of [...state.reservations.values(), ...state.writerOrphans.values()]) {
      if (!pathsConflict(holder.path, root) && !pathsConflict(holder.path, task.path)) continue
      const quiet = allowQuietOwn && own !== undefined && holder === own && !own.finishing && !own.uncertain && !own.cancelled && isReplied(own)
      if (!quiet) throw fail('workbench_busy')
      quietOwn = own
    }
    if (own && own !== quietOwn) throw fail('workbench_busy')
    if (state.queue.some(item => item.state === 'queued' && (pathsConflict(item.path, root) || pathsConflict(item.path, task.path)))) throw fail('workbench_busy')
    if (ctx.deps.executionConflict?.(task.path, task.providerId, task.sessionId)) throw fail('workbench_busy')
    // 3. 没有别的动作在碰工作区
    if (domains.scripts.busy(id) || domains.until.checking(id)) throw fail('workbench_busy')
    if (store.liveInputs.count(id) > 0) throw fail('workbench_busy')
    // 1. 是 linked worktree、HEAD 在它自己的分支上、没有进行中的 git 动作
    const g: RewindGit = { root, filters, stateDir: ctx.stateDir }
    let ws: ReturnType<typeof worktreeState>
    try { ws = worktreeState(g) } catch { throw fail('rewind_unavailable', { reason: 'git_error' }) }
    if (!ws.gitDir || ws.gitDir === ws.commonDir) throw fail('rewind_unavailable', { reason: 'not_linked_worktree' })
    if (ws.headRef !== `refs/heads/${wt.branch}`) throw fail('rewind_unavailable', { reason: 'branch_moved' })
    if (ws.inProgress) throw fail('rewind_unavailable', { reason: 'git_in_progress', detail: ws.inProgress })
    const head = revParse(g, 'HEAD')
    if (!head) throw fail('rewind_unavailable', { reason: 'unborn' })
    return { task, wt, root, g, head, ...(quietOwn ? { quietOwn } : {}) }
  }

  /** 前置 4–7 + 要撤掉哪几轮。TB = 当前完整状态的树(备份 B 的树)。 */
  function plan(id: string, sc: Scene, input: RewindTarget, TB: string) {
    if (!input || typeof input.artifactId !== 'string' || (input.to !== 'start' && input.to !== 'end')) throw fail('invalid_request')
    const all = rounds(id)
    const target = all.find(r => r.artifactId === input.artifactId)
    if (!target) { store.artifact(id, input.artifactId); throw fail('invalid_review_reference') }
    if (target.discarded) throw fail('review_round_discarded')
    if (!target.review) throw fail('invalid_review_reference')
    const C = input.to === 'end' ? target.review.checkpointAfter : target.review.checkpointBefore
    if (!C) throw fail('rewind_unavailable', { reason: 'no_checkpoint' })
    if (!checkpointRefSet(sc.root, id)?.has(C)) throw fail('rewind_unavailable', { reason: 'checkpoint_missing' })
    const info = commitOf(sc.g, C)
    if (!info || info.parents.length !== 1) throw fail('rewind_unavailable', { reason: 'checkpoint_missing' })
    const T = info.tree, P = info.parents[0]!
    const discarded = all.filter(r => !r.discarded && (input.to === 'end' ? r.n > target.n : r.n >= target.n))
    // 5. 不共用文件夹:别的没归档任务也在这个文件夹里、且有比目标点新的成果
    const since = input.to === 'end' ? target.createdAt : (target.review.startedAt || target.createdAt)
    for (const other of store.list()) {
      if (other.id === id || other.archivedAt !== null) continue
      if (!pathsConflict(other.path, sc.root) && !pathsConflict(other.path, sc.task.path)) continue
      if (store.artifacts(other.id).some(a => a.createdAt > since)) throw fail('rewind_shared_folder')
    }
    // 6. 要丢的提交没合回过项目;别的分支 / remote 里有 ⇒ 只提示
    let projectHead: string | null = null
    try { projectHead = revParse({ ...sc.g, root: real(sc.wt.repoRoot) }, 'HEAD') } catch { /* 项目读不了就不判 */ }
    const dropped = droppedCommits(sc.g, P, sc.head, sc.wt.branch, projectHead)
    if (dropped.merged) throw fail('rewind_merged')
    // 7. 不覆盖被 ignore 的文件
    const conflicts = ignoredConflicts(sc.g, T, TB)
    if (conflicts.length) throw fail('rewind_ignored_conflict', { paths: conflicts.slice(0, MAX_LISTED) })
    if (!discarded.length && T === TB && sc.head === P) throw fail('rewind_noop')
    const discardedIds = discarded.map(r => r.artifactId)
    return { all, target, C, T, P, discarded, discardedIds, dropped, token: tokenOf({ taskId: id, C, TB, HEAD: sc.head, discardedIds }) }
  }

  /** 预览 / 执行都先把当前完整状态打成 B(异步,checkpoint 模块);打不成 ⇒ 不可回退。 */
  async function backupNow(id: string, root: string): Promise<{ commit: string; tree: string; filters: string[] }> {
    const args = await checkpointGitArgs(root)
    if ('skipped' in args) throw fail('rewind_unavailable', { reason: args.skipped })
    const b = await takeCheckpoint({ root, taskId: id, stateDir: ctx.stateDir, ...(ctx.deps.checkpointDeadlineMs !== undefined ? { deadlineMs: ctx.deps.checkpointDeadlineMs } : {}) })
    if ('skipped' in b) throw fail('rewind_unavailable', { reason: b.skipped })
    return { commit: b.commit, tree: b.tree, filters: args.filters }
  }

  /** 这件事自己那条安静的保留会话:按 closeForIdle 的方式收工,等它真关掉。 */
  async function closeQuiet(id: string, own: Active) {
    note(id, '回退之前先收工:这件事安静着的会话已关掉,下一句会按原会话恢复。')
    own.closedWhileReplied = true
    try { domains.lifecycle.cancelRun(own) } catch { /* 已经在收尾 */ }
    const wait = opts.closeWaitMs ?? (ctx.deps.closeTimeoutMs ?? 3000) + 5000
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([own.done, new Promise<void>(resolve => { timer = setTimeout(resolve, wait) })])
    if (timer) clearTimeout(timer)
  }

  function goalOf(id: string, all: Round[], discarded: Set<string>) {
    const goal = store.goals.get(id)
    if (!goal) return null
    // 通过的那一轮 = 通过时刻之前最近的一轮
    const passing = goal.status === 'passed' ? [...all].reverse().find(r => r.createdAt <= goal.updatedAt) : undefined
    return { goal, willStop: goal.status === 'active' || (goal.status === 'passed' && !!passing && discarded.has(passing.artifactId)) }
  }
  /** 回退做成之后:goal 停下(评审 7)、时间线一句、唤醒。 */
  function settleDone(row: RewindRow) {
    const id = row.taskId
    if (isRestoreRow(row)) { const p7 = commitParentShort(row); note(id, `已按你的选择把工作区恢复成那次回退之前的样子${p7 ? `，分支回到 ${p7}` : ''}。`); return }
    if (isUndoRow(row)) {
      const original = store.rewinds.get(row.targetArtifactId.slice('undo:'.length))
      if (original) store.rewinds.undo(original.id, row.id)
      const all = rounds(id), ns = all.filter(r => original?.discarded.includes(r.artifactId)).map(r => r.n)
      note(id, `已撤销回退：${ns.length ? `${rangeText(ns)}的改动回来了，` : '回退前的样子回来了，'}分支回到 ${(original?.priorHead ?? row.priorHead).slice(0, 7)}。`)
      return
    }
    const all = rounds(id)
    const target = all.find(r => r.artifactId === row.targetArtifactId)
    const ns = all.filter(r => row.discarded.includes(r.artifactId)).map(r => r.n)
    const g = goalOf(id, all, new Set(row.discarded))
    if (g?.willStop) {
      if (g.goal.status === 'active') domains.until.stop(id, REWIND_GOAL_REASON)
      else { store.goals.revokePassed(id, REWIND_GOAL_REASON); note(id, `「直到检查通过」停了:${REWIND_GOAL_REASON}`) }
    }
    note(id, `已回到${target ? pointText(target.n, row.targetPoint) : '之前的一个点'}，撤掉了${ns.length ? rangeText(ns) : '之后的额外改动'}（已备份，可撤销）。`)
  }

  function commitParentShort(row: RewindRow): string {
    try { const wt = store.worktrees.get(row.taskId); return wt ? commitOf({ root: real(wt.root), filters: [], stateDir: ctx.stateDir }, row.targetCommit)?.parents[0]?.slice(0, 7) ?? '' : '' } catch { return '' }
  }
  function uniqueRef(g: RewindGit, id: string): string {
    let at = ctx.now()
    while (revParse(g, `${REWIND_REF_PREFIX}${id}/${at}`)) at++
    return `${REWIND_REF_PREFIX}${id}/${at}`
  }

  /**
   * 执行段(同步,保原子):重查前置 → 重算 TB 对上 token → 写意图 → applyRewind(备份 ref、切换、CAS 挪分支、真 index、校验)。
   * 失败 ⇒ 意图行 failed、事件里写备份 ref、抛 rewind_failed。
   */
  function applySync(id: string, B: { commit: string; tree: string; filters: string[] }, how: { kind: 'rewind'; input: RewindTarget & { token: string } } | { kind: 'undo' | 'restore'; row: RewindRow }): RewindResult {
    const sc = scene(id, B.filters, false, how.kind === 'restore')
    const backupInfo = commitOf(sc.g, B.commit)
    if (!backupInfo || backupInfo.parents[0] !== sc.head) throw fail(how.kind === 'rewind' ? 'rewind_confirmation_stale' : 'workbench_busy')
    let target: { commit: string; tree: string; parent: string }, discarded: string[] = [], point: Point = 'end', artifactId: string
    let verify: (() => { path: string; eol: boolean } | null) | undefined
    if (how.kind === 'rewind') {
      const p = plan(id, sc, how.input, B.tree)
      if (p.token !== how.input.token) throw fail('rewind_confirmation_stale')
      target = { commit: p.C, tree: p.T, parent: p.P }; discarded = p.discardedIds; point = how.input.to; artifactId = how.input.artifactId
      const files = (p.target.review?.files ?? []).filter(f => f.kind !== 'not_reviewed')
      // 快照里列出的文件对上那一刻的内容(Windows 上 eol 只保证 git 等价,不比字节)
      if (process.platform !== 'win32') verify = () => {
        for (const f of files) {
          const want = point === 'end' ? f.afterSha256 : f.beforeSha256
          const gone = point === 'end' ? f.kind === 'deleted' : f.kind === 'added'
          const file = join(sc.task.path, f.path), have = fileSha256(file)
          if (gone ? have === null : !!want && have === want) continue
          // 只差换行:.gitattributes 的 eol / text 让检出的字节变了(评审 #433-6)
          let eol = false
          if (want && have !== null) { try { const lf = readFileSync(file).toString('latin1').replace(/\r\n/g, '\n'); eol = sha(Buffer.from(lf, 'latin1')) === want || sha(Buffer.from(lf.replace(/\n/g, '\r\n'), 'latin1')) === want } catch { /* 当内容不同 */ } }
          return { path: f.path, eol }
        }
        return null
      }
    } else {
      const row = how.row
      const info = commitOf(sc.g, row.backupCommit)
      if (!info || info.parents.length !== 1 || revParse(sc.g, row.backupRef) !== row.backupCommit) throw fail('rewind_unavailable', { reason: 'backup_missing' })
      target = { commit: row.backupCommit, tree: info.tree, parent: info.parents[0]! }; artifactId = how.kind === 'restore' ? `${RESTORE_PREFIX}${row.id}` : undoTargetId(row.id)
      let projectHead: string | null = null
      try { projectHead = revParse({ ...sc.g, root: real(sc.wt.repoRoot) }, 'HEAD') } catch { /* 不判 */ }
      if (droppedCommits(sc.g, target.parent, sc.head, sc.wt.branch, projectHead).merged) throw fail('rewind_merged')
      const conflicts = ignoredConflicts(sc.g, target.tree, B.tree)
      if (conflicts.length) throw fail('rewind_ignored_conflict', { paths: conflicts.slice(0, MAX_LISTED) })
    }
    // 1. 重算 TB:工作区此刻必须还是备份 B 的树(那段 await 里有人动过 ⇒ 过期)
    const pre = workTree(sc.g, B.tree)
    try {
      if (pre.tree !== B.tree) throw fail(how.kind === 'rewind' ? 'rewind_confirmation_stale' : 'workbench_busy')
      const backupRef = uniqueRef(sc.g, id)
      // 0. 先写意图(评审 4)
      const row = store.rewinds.record({ taskId: id, targetArtifactId: artifactId, targetPoint: point, targetCommit: target.commit, priorHead: sc.head, backupRef, backupCommit: B.commit, discarded, createdAt: ctx.now() })
      const result = applyRewind({ g: sc.g, branchRef: `refs/heads/${sc.wt.branch}`, oldHead: sc.head, target, backup: { commit: B.commit, tree: B.tree }, backupRef, index: pre.index, ...(verify ? { verify } : {}), ...(opts.inject ? { inject: opts.inject } : {}) })
      if (!result.ok) {
        ctx.log?.('workbench', `rewind failed task=${id} error=${result.error} rolledBack=${result.rolledBack}`)
        const why = failureText(result.error, result.path)
        const steps = rollbackText(result)
        if (result.rolledBack) {
          store.rewinds.setState(row.id, 'failed')
          note(id, `回退没做成（${why}），已经恢复原样${steps ? `：${steps}` : ''}。回退前的完整状态另有备份：${backupRef}。`)
        } else park(row, `回退没做成（${why}），也没能完整恢复原样：${steps}。这件事先停住了，请在桌面查看后选「保留现在的样子」或「恢复到回退之前」。回退前的完整状态备份在 ${backupRef}。`)
        throw fail('rewind_failed', { rolledBack: result.rolledBack, backupRef, reason: result.error === 'rewind_verify_eol' ? 'eol_mismatch' : result.error, ...(result.path ? { path: result.path } : {}), steps: result.steps, conflicts: result.conflicts })
      }
      store.rewinds.setState(row.id, 'done')
      if (how.kind === 'restore') { store.rewinds.resolve(how.row.id, 'restore_backup'); store.clearError(id, 'rewind_needs_owner') }
      settleDone(store.rewinds.get(row.id)!)
      return { rewindId: row.id, backupRef, head: target.parent, discarded }
    } finally { dropIndex(pre.index) }
  }

  async function guarded<T>(id: string, fn: () => Promise<T>): Promise<T> {
    ctx.ensureAccepting()
    if (inflight.has(id)) throw fail('workbench_busy')
    inflight.add(id)
    try { return await fn() } finally { inflight.delete(id) }
  }
  /** 最近一次可撤销的回退;之后又有新的审阅轮 ⇒ rewind_undo_stale(备份 ref 留着手工恢复)。expected = 桌面看到的那一次,换了 ⇒ stale。 */
  function undoable(id: string, expected?: string): RewindRow {
    const latest = store.rewinds.latest(id)
    if (!latest || isUndoRow(latest) || isRestoreRow(latest) || latest.undoneAt !== null) throw fail(expected ? 'rewind_undo_stale' : 'rewind_undo_unavailable')
    if (expected !== undefined && latest.id !== expected) throw fail('rewind_undo_stale')
    if (rounds(id).some(r => r.createdAt > latest.createdAt)) throw fail('rewind_undo_stale')
    return latest
  }

  /** 开机对账一行(评审 4):能确认就补完 / 回滚,确认不了就停住这件事并写一条事件。 */
  async function reconcile(row: RewindRow) {
    const id = row.taskId
    const unknown = () => park(row, `上次回退中途被打断，现场核对不上，CC 没有再动它。这件事先停住了，请在桌面查看后选「保留现在的样子」或「恢复到回退之前」。回退前的完整状态备份在 ${row.backupRef}。`)
    try { await reconcileOne(row, unknown) } catch (error) {
      // 对账自己出错(超时 / 锁 / CAS 失败)也一样停住,不悄悄当 failed(评审 #433-3)
      ctx.log?.('workbench', `rewind reconcile error task=${id}: ${error instanceof Error ? error.message : error}`)
      unknown()
    }
  }
  async function reconcileOne(row: RewindRow, unknown: () => void) {
    const id = row.taskId
    const wt = store.worktrees.get(id)
    if (!wt || wt.removedAt !== null) { unknown(); return }
    let root: string
    try { root = real(wt.root) } catch { unknown(); return }
    const args = await checkpointGitArgs(root)
    if ('skipped' in args) { unknown(); return }
    const g: RewindGit = { root, filters: args.filters, stateDir: ctx.stateDir }
    const target = commitOf(g, row.targetCommit), backup = commitOf(g, row.backupCommit)
    if (!target || target.parents.length !== 1 || !backup) { unknown(); return }
    const parent = target.parents[0]!, branchRef = `refs/heads/${wt.branch}`
    const verdict = inspectApplying(g, { branchRef, priorHead: row.priorHead, target: { tree: target.tree, parent }, backupTree: backup.tree })
    if (verdict === 'unknown') { unknown(); return }
    if (verdict === 'applied' || verdict === 'files_only') {
      if (verdict === 'files_only') git(g, ['update-ref', branchRef, parent, row.priorHead])
      git(g, ['read-tree', parent])
      store.rewinds.setState(row.id, 'done')
      note(id, 'CC 上次退出时回退刚做完，记录已经补上。')
      settleDone(store.rewinds.get(row.id)!)
      return
    }
    if (verdict === 'branch_only') { git(g, ['update-ref', branchRef, row.priorHead, parent]); git(g, ['read-tree', row.priorHead]) }
    store.rewinds.setState(row.id, 'failed')
    note(id, 'CC 上次退出时回退没做完，工作区和分支都是回退前的样子，可以重新回退。')
  }

  /**
   * 停住这件事(评审 #433-4):行改 needs_owner(持久的闸:派发 / 补充 / 工作区动作 / 回退一律 rewind_needs_owner),
   * goal 停,任务标 rewind_needs_owner,写一句。主人用 rewindResolve 拍板。
   */
  function park(row: RewindRow, text: string) {
    const id = row.taskId
    try { store.rewinds.setState(row.id, 'needs_owner') } catch { /* 下面照说 */ }
    try { domains.until.stop(id, REWIND_GOAL_REASON) } catch { /* 没有 goal */ }
    try { if (store.goals.get(id)?.status === 'passed') store.goals.revokePassed(id, REWIND_GOAL_REASON) } catch { /* 同上 */ }
    try { const t = store.get(id); if (!['queued', 'running', 'cancelling'].includes(t.status)) store.update(id, 'interrupted', 'rewind_needs_owner') } catch { /* 任务没了 */ }
    // 崩溃留下的 git 锁会让「恢复」被当成 git 正在进行中而拒掉 —— 先说清楚(评审 #433 小点)
    note(id, `${text}${REWIND_PARK_NOTE_TAIL}`)
  }
  function failureText(code: string, path?: string): string {
    if (code === 'rewind_verify_eol') return `${path} 检出后的换行和那一刻不一样 —— 项目的 .gitattributes 里有换行设置(eol / text),这件事不能按字节回退`
    if (code === 'rewind_verify_file') return `${path} 的内容和那一刻对不上`
    return code
  }

  /** ref 的去留(评审 1、5):cc/<id> 分支没了 ⇒ 清;任务归档满 30 天 ⇒ 清。删工作区本身不清。 */
  async function pruneRefs(now = ctx.now()): Promise<number> {
    let removed = 0
    let rows: ReturnType<typeof store.worktrees.all>
    try { rows = store.worktrees.all() } catch { return 0 }
    const applying = new Set(store.rewinds.applying().map(r => r.taskId))
    for (const w of rows) {
      // 停住等主人拍板的(needs_owner)也不清:restore_backup 要用的就是这份备份(评审 #433 小点)
      if (applying.has(w.taskId) || inflight.has(w.taskId) || store.rewinds.blocking(w.taskId) === 'needs_owner') continue
      const expired = w.archivedAt !== null && now - w.archivedAt > REWIND_RETAIN_MS
      const gone = expired ? false : (await branchExists(w.repoRoot, w.branch)) === false
      if (expired || gone) removed += await deleteCheckpointRefs(w.repoRoot, w.taskId)
    }
    return removed
  }

  return {
    rounds,
    /**
     * 预览(两步确认的第一步):先把当前完整状态打成 B,回 token、会撤掉的轮次、文件摘要、额外改动、会话与 goal 怎么处理。
     */
    async rewindPreview(id: string, input: RewindTarget): Promise<RewindPreview> {
      return guarded(id, async () => {
        const first = scene(id, [], true)
        const B = await backupNow(id, first.root)
        const sc = scene(id, B.filters, true)
        const p = plan(id, sc, input, B.tree)
        const last = [...p.all].reverse().find(r => !r.discarded && r.review?.checkpointAfter)
        let extra: RewindPreview['extraChanges'] = null
        const lastAfter = last?.review?.checkpointAfter
        const lastInfo = lastAfter ? commitOf(sc.g, lastAfter) : null
        if (lastInfo) extra = listed(nameStatus(sc.g, lastInfo.tree, B.tree))
        const goal = goalOf(id, p.all, new Set(p.discardedIds))
        return {
          token: p.token,
          target: { artifactId: input.artifactId, to: input.to, round: p.target.n },
          discarded: p.discarded.map(r => ({ artifactId: r.artifactId, round: r.n })),
          files: listed(nameStatus(sc.g, p.T, B.tree)),
          extraChanges: extra,
          droppedCommits: { count: p.dropped.count, elsewhere: p.dropped.elsewhere },
          ignoredUntouched: true, rebuildHint: REWIND_REBUILD_HINT, refsNote: REWIND_REFS_NOTE,
          session: sc.quietOwn ? 'will_close' : 'none',
          devServer: domains.scripts.serving(id),
          goal: goal ? { status: goal.goal.status, willStop: goal.willStop } : null,
        }
      })
    },
    /** 执行(带预览给的 token)。没带 ⇒ rewind_confirmation_required;工作区 / 轮次在那之后变了 ⇒ rewind_confirmation_stale。 */
    async rewind(id: string, input: RewindTarget & { token?: string }): Promise<RewindResult> {
      if (input?.token === undefined || input.token === '') throw fail('rewind_confirmation_required')
      if (typeof input.token !== 'string' || !/^[a-f0-9]{64}$/.test(input.token)) throw fail('invalid_request')
      const token = input.token
      return guarded(id, async () => {
        const first = scene(id, [], true)
        if (first.quietOwn) await closeQuiet(id, first.quietOwn)
        const root = first.quietOwn ? scene(id, [], false).root : first.root
        const B = await backupNow(id, root)
        return applySync(id, B, { kind: 'rewind', input: { artifactId: input.artifactId, to: input.to, token } })
      })
    },
    /** 撤销最近一次回退:同一套流程,目标 = 那次的备份 B;撤销本身也先备份。 */
    async undoRewind(id: string, expected?: string): Promise<RewindResult> {
      return guarded(id, async () => {
        // 先看库里的事实(之后有没有新的审阅轮 / 是不是桌面看到的那一次),再碰工作区:有新一轮就是 stale,
        // 跟工作区这会儿是不是正被 git 占着无关(以前反过来,CI 偶发报成 rewind_unavailable)
        undoable(id, expected)
        const first = scene(id, [], true)
        if (first.quietOwn) await closeQuiet(id, first.quietOwn)
        const root = first.quietOwn ? scene(id, [], false).root : first.root
        const B = await backupNow(id, root)
        return applySync(id, B, { kind: 'undo', row: undoable(id, expected) })
      })
    },
    /**
     * 执行者下一轮开头的告知(execute 拼请求时前置);没有 ⇒ null。ids 是这一句覆盖的待告知行,派发确认送达后 markNoticed。
     */
    notice(id: string): { text: string; ids: string[] } | null {
      let pending: RewindRow[]
      try { pending = store.rewinds.pendingNotice(id) } catch { return null }
      const row = pending.at(-1)
      if (!row) return null
      const ids = pending.map(r => r.id)
      const all = rounds(id)
      if (isRestoreRow(row) || row.resolution === 'restore_backup') return { ids, text: `【工作区上次回退中途被打断,主人把它恢复成了回退之前的样子】${isRestoreRow(row) && commitParentShort(row) ? `分支回到 ${commitParentShort(row)};` : ''}以磁盘现状为准,先重新查看再继续。` }
      if (row.resolution === 'keep') return { ids, text: '【工作区上次回退中途被打断,主人确认保留现在的样子】有的文件可能停在半路,以磁盘现状为准,先重新查看再继续。' }
      if (isUndoRow(row)) {
        const original = store.rewinds.get(row.targetArtifactId.slice('undo:'.length))
        const ns = all.filter(r => original?.discarded.includes(r.artifactId)).map(r => r.n)
        return { ids, text: `【主人撤销了刚才的回退】之前撤掉的${ns.length ? rangeText(ns) : '改动'}又回来了${original ? `、分支回到 ${original.priorHead.slice(0, 7)}` : ''};以磁盘现状为准,先重新查看再继续。` }
      }
      const target = all.find(r => r.artifactId === row.targetArtifactId)
      const ns = all.filter(r => row.discarded.includes(r.artifactId)).map(r => r.n)
      let parent = ''
      try { const wt = store.worktrees.get(id); if (wt) parent = commitOf({ root: real(wt.root), filters: [], stateDir: ctx.stateDir }, row.targetCommit)?.parents[0]?.slice(0, 7) ?? '' } catch { /* 没有短号也照说 */ }
      const where = target ? pointText(target.n, row.targetPoint) : '之前的一个点'
      return { ids, text: `【工作区已被主人回到${where}】${ns.length ? rangeText(ns) : '之后'}的文件改动已撤销${parent ? `、分支回到 ${parent}` : ''};那几轮你做过的改动都不在了,以磁盘现状为准,先重新查看再继续。被撤掉的那几轮的做法,除非主人要求,别重做。` }
    },
    markNoticed(id: string, ids: readonly string[]) { try { store.rewinds.markNoticed(id, ids); ctx.hub.touched(id) } catch { /* 下次再带一遍 */ } },
    /**
     * 主人拍板停住的那件事(评审 #433-4;切片 3 接桌面):keep = 工作区就按现在的样子接着做;
     * restore_backup = 先把现状再备份一次,然后回到那次回退之前(备份 B、分支回旧 HEAD)。拍板后告知照样送到执行者。
     */
    async rewindResolve(id: string, choice: 'keep' | 'restore_backup'): Promise<{ resolution: 'keep' | 'restore_backup'; rewindId?: string }> {
      if (choice !== 'keep' && choice !== 'restore_backup') throw fail('invalid_request')
      await ready
      return guarded(id, async () => {
        const row = store.rewinds.blocker(id)
        if (!row || row.state !== 'needs_owner') throw fail('rewind_not_blocked')
        if (choice === 'keep') {
          store.rewinds.resolve(row.id, 'keep'); store.clearError(id, 'rewind_needs_owner')
          note(id, '已按你的选择保留工作区现在的样子，可以接着做了。')
          return { resolution: 'keep' }
        }
        const first = scene(id, [], false, true)
        const B = await backupNow(id, first.root)
        const done = applySync(id, B, { kind: 'restore', row: store.rewinds.get(row.id)! })
        return { resolution: 'restore_backup', rewindId: done.rewindId }
      })
    },
    /** 开机对账做完(execute 先等它;评审 #433-4)。 */
    ready: () => ready,
    /** 开机(service 建起来时调一次):对账卡在 applying 的意图行;再排每天一次的 ref 清理。 */
    recover(): Promise<void> {
      let rows: RewindRow[] = []
      try { rows = store.rewinds.applying() } catch { /* 表不在 */ }
      const done = (async () => { for (const row of rows) await reconcile(row) })()
      ready = done.catch(() => {})
      const tick = () => { void pruneRefs().catch(() => {}) }
      const first = setTimeout(() => { tick(); const daily = setInterval(tick, DAY_MS); daily.unref?.(); timers.push(daily as unknown as ReturnType<typeof setTimeout>) }, 10 * 60_000)
      first.unref?.(); timers.push(first)
      return done
    },
    pruneRefs,
    shutdown() { for (const t of timers) { clearTimeout(t); clearInterval(t) } timers = [] },
  }
}
export type RewindDomain = ReturnType<typeof makeRewindDomain>
