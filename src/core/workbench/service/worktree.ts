/**
 * 独立工作区的动作(2026-10-07):提交到分支、删工作区目录;10-08 加「合回项目」(只快进,别的交给主人,给一行可复制的命令)。
 * 都要求没有会话占着这个目录(执行者随时可能再写),和逐文件撤销同一道门;合回还要求源项目目录没被别的任务占着。
 */
import { pathsConflict } from '../scheduler'
import { commitWorktree, mergeHint, mergeWorktree, removeWorktree } from '../worktree-workspaces'
import type { ServiceCtx } from './ctx'

type Action = 'commit' | 'remove' | 'merge'

export function makeWorktreeDomain(ctx: ServiceCtx) {
  const { store, state } = ctx
  /**
   * 提交只是给文件拍快照(之后又写的,最坏是没进这次提交,不会弄坏东西)⇒ 这件事自己保留的会话已经答复、安静着,
   * 就不必先收工(真机核对 10-07:答复后会话保留 10 分钟,那段时间点「提交到分支」一律被拒)。删工作区要删目录,仍要先收工。
   */
  function target(id: string, action: Action) {
    const task = store.get(id)
    const wt = store.worktrees.get(id)
    if (!wt) throw new Error('not_worktree')
    if (wt.removedAt !== null) throw new Error('worktree_removed')
    if (task.error === 'writer_not_closed') throw new Error('workbench_busy')
    for (const holder of [...state.reservations.values(), ...state.writerOrphans.values()]) {
      if (!pathsConflict(holder.path, task.path)) continue
      const own = state.runsByTask.get(id)
      const quietOwn = action !== 'remove' && own !== undefined && holder === own && !own.finishing && !own.uncertain && ctx.actions.deref('worktree').isReplied(own)
      if (!quietOwn) throw new Error('workbench_busy')
    }
    // 合回会改项目目录里的文件:那里有别的任务在跑(或关不掉的执行程序)⇒ 不动。
    if (action === 'merge') for (const holder of [...state.reservations.values(), ...state.writerOrphans.values()]) {
      if (pathsConflict(holder.path, wt.projectPath) || pathsConflict(holder.path, wt.repoRoot)) throw new Error('project_busy')
    }
    return { task, wt }
  }
  return {
    worktreeAction(id: string, action: Action): { branch: string; committed?: boolean; sha?: string; mergeHint?: string; removed?: boolean; merged?: boolean; into?: string } {
      if (action !== 'commit' && action !== 'remove' && action !== 'merge') throw new Error('invalid_request')
      const { task, wt } = target(id, action)
      if (action === 'commit') {
        const result = commitWorktree(wt.root, task.title)
        const hint = mergeHint(wt.projectPath, wt.branch)
        store.addEvent(id, 'system', result.committed ? `已提交到分支 ${wt.branch}（${result.sha.slice(0, 7)}）。合并到项目：${hint}` : `分支 ${wt.branch} 上没有新的改动要提交。`)
        ctx.hub.touched(id)
        return { branch: wt.branch, committed: result.committed, sha: result.sha, mergeHint: hint }
      }
      if (action === 'merge') {
        const result = mergeWorktree(wt.repoRoot, wt.root, wt.branch)
        store.worktrees.markMerged(id)
        store.addEvent(id, 'system', result.merged ? `分支 ${wt.branch} 已快进合并到项目的 ${result.into}。` : `分支 ${wt.branch} 的内容已经在项目的 ${result.into} 里了。`)
        ctx.hub.touched(id)
        return { branch: wt.branch, merged: true, into: result.into }
      }
      removeWorktree(wt.repoRoot, wt.root)
      store.worktrees.markRemoved(id)
      store.addEvent(id, 'system', `独立工作区已删除，分支 ${wt.branch} 保留在项目里。`)
      ctx.hub.touched(id)
      return { branch: wt.branch, removed: true }
    },
  }
}
