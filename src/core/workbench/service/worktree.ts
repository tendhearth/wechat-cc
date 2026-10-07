/**
 * 独立工作区的两个动作(2026-10-07):提交到分支、删工作区目录。合并留给主人(给一行可复制的命令)。
 * 两个动作都要求没有会话占着这个目录(执行者随时可能再写),和逐文件撤销同一道门。
 */
import { pathsConflict } from '../scheduler'
import { commitWorktree, mergeHint, removeWorktree } from '../worktree-workspaces'
import type { ServiceCtx } from './ctx'

export function makeWorktreeDomain(ctx: ServiceCtx) {
  const { store, state } = ctx
  function target(id: string) {
    const task = store.get(id)
    const wt = store.worktrees.get(id)
    if (!wt) throw new Error('not_worktree')
    if (wt.removedAt !== null) throw new Error('worktree_removed')
    if (task.error === 'writer_not_closed') throw new Error('workbench_busy')
    for (const holder of [...state.reservations.values(), ...state.writerOrphans.values()]) if (pathsConflict(holder.path, task.path)) throw new Error('workbench_busy')
    return { task, wt }
  }
  return {
    worktreeAction(id: string, action: 'commit' | 'remove'): { branch: string; committed?: boolean; sha?: string; mergeHint?: string; removed?: boolean } {
      if (action !== 'commit' && action !== 'remove') throw new Error('invalid_request')
      const { task, wt } = target(id)
      if (action === 'commit') {
        const result = commitWorktree(wt.root, task.title)
        const hint = mergeHint(wt.projectPath, wt.branch)
        store.addEvent(id, 'system', result.committed ? `已提交到分支 ${wt.branch}（${result.sha.slice(0, 7)}）。合并到项目：${hint}` : `分支 ${wt.branch} 上没有新的改动要提交。`)
        ctx.hub.touched(id)
        return { branch: wt.branch, committed: result.committed, sha: result.sha, mergeHint: hint }
      }
      removeWorktree(wt.repoRoot, wt.root)
      store.worktrees.markRemoved(id)
      store.addEvent(id, 'system', `独立工作区已删除，分支 ${wt.branch} 保留在项目里。`)
      ctx.hub.touched(id)
      return { branch: wt.branch, removed: true }
    },
  }
}
