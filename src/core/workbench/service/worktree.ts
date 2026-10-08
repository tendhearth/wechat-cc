/**
 * 独立工作区的两个动作(2026-10-07):提交到分支、删工作区目录。合并留给主人(给一行可复制的命令)。
 * 两个动作都要求没有会话占着这个目录(执行者随时可能再写),和逐文件撤销同一道门。
 */
import {existsSync} from 'node:fs'
import {createGitRunner} from '../git-runner'
import { pathsConflict } from '../scheduler'
import { commitWorktree, mergeHint, removeWorktree } from '../worktree-workspaces'
import type { ServiceCtx } from './ctx'

export function makeWorktreeDomain(ctx: ServiceCtx) {
  const { store, state } = ctx
  /**
   * 提交只是给文件拍快照(之后又写的,最坏是没进这次提交,不会弄坏东西)⇒ 这件事自己保留的会话已经答复、安静着,
   * 就不必先收工(真机核对 10-07:答复后会话保留 10 分钟,那段时间点「提交到分支」一律被拒)。删工作区要删目录,仍要先收工。
   */
  function target(id: string, action: 'commit' | 'remove') {
    const task = store.get(id)
    const wt = store.worktrees.get(id)
    if (!wt) throw new Error('not_worktree')
    if (wt.removedAt !== null) throw new Error('worktree_removed')
    if (task.error === 'writer_not_closed') throw new Error('workbench_busy')
    for (const holder of [...state.reservations.values(), ...state.writerOrphans.values()]) {
      if (!pathsConflict(holder.path, task.path)) continue
      const own = state.runsByTask.get(id)
      const quietOwn = action === 'commit' && own !== undefined && holder === own && !own.finishing && !own.uncertain && ctx.actions.deref('worktree').isReplied(own)
      if (!quietOwn) throw new Error('workbench_busy')
    }
    return { task, wt }
  }
  type Result={branch:string;committed?:boolean;sha?:string;mergeHint?:string;removed?:boolean}
  async function boundAction(id:string,action:'commit'|'remove'):Promise<Result>{
    const recovery=ctx.recovery!,{task,w}=recovery.owned(id)
    recovery.gate(task.path)
    const reservation=<T>(fn:()=>Promise<T>)=>action==='commit'?recovery.withCommit(id,fn):recovery.withMutation(w.id,fn)
    return reservation(async()=>{
      if(action==='remove'&&recovery.manager.blocked(w.id))throw Error('workspace_blocked')
      await recovery.git().verify(w)
      const git=createGitRunner(),read=async(path:string,args:string[])=>(await git.run(path,args)).toString('utf8').trim()
      if(action==='remove'){
        if(await read(w.worktreeRoot,['status','--porcelain','--untracked-files=all']))throw Error('worktree_dirty')
        await recovery.git().verify(w)
        await git.run(w.gitRoot,['worktree','remove','--',w.worktreeRoot])
        if(existsSync(w.worktreeRoot))throw Error('git_workspace_needs_recovery')
        store.atomic(()=>{store.gitWorkspaces.update({...w,removedAt:ctx.now()});store.addEvent(id,'system',`Workspace removed; branch retained: ${w.branch}`)})
        ctx.hub.touched(id);return {branch:w.branch,removed:true}
      }
      const quiet=()=>{const own=state.runsByTask.get(id);if(own&&(own.finishing||own.uncertain||!ctx.actions.deref('workspace-commit').isReplied(own)))throw Error('writer_not_closed')}
      quiet()
      const files=(await git.run(w.executionPath,['ls-files','--cached','--others','--exclude-standard','-z','--','.'])).toString('utf8').split('\0').filter(p=>p&&!p.split('/').some(part=>/^\.cc-workbench/i.test(part)))
      if(files.length>50000)throw Error('git_output_limit')
      let committed=false
      if(files.length){
        quiet()
        await git.run(w.executionPath,['add','-A','--',...files])
        if(await read(w.executionPath,['diff','--cached','--name-only','--',...files])){
          quiet()
          await git.run(w.executionPath,['-c','user.name=Tendhearth CC','-c','user.email=cc@localhost','-c','commit.gpgsign=false','commit','--no-verify','--only','-m',task.title.slice(0,200)||'Workspace changes','--',...files]);committed=true
        }
      }
      const sha=await read(w.executionPath,['rev-parse','HEAD']),hint=mergeHint(w.sourcePath,w.branch)
      store.addEvent(id,'system',`Workspace commit: ${sha}`);ctx.hub.touched(id)
      return {branch:w.branch,committed,sha,mergeHint:hint}
    })
  }
  return {
    worktreeAction(id: string, action: 'commit' | 'remove'): Result|Promise<Result> {
      if (action !== 'commit' && action !== 'remove') throw new Error('invalid_request')
      if(store.gitWorkspaceForTask(id))return boundAction(id,action)
      const { task, wt } = target(id, action)
      ctx.recovery?.gate(task.path)
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
