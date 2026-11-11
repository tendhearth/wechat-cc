/** 只续接部署关停明确标记的轮；主人停止、写者未退出及恢复确认门仍然有效。 */
import { createHash } from 'node:crypto'
import { readRestartContinuations, dropRestartContinuation } from '../../../adapters/workbench/restart-continuations'
import { timelineKind } from '../../../adapters/store/workbench/store'
import type { ServiceCtx } from './ctx'
import type { ExecuteDomain } from './execute'
import { directoryIdentity } from './directory-identity'
import { canonicalProject } from '../../../adapters/workbench/artifacts'

export const RESTART_RESUME_TEXT = 'CC 重启打断了上一轮。先检查停在哪里，再接着完成原任务。'
/** Quarantine crash-window records synchronously, before adopting writer holds. */
export function quarantineRestartContinuations(ctx:ServiceCtx):void {
  let entries
  try {entries=readRestartContinuations(ctx.stateDir)} catch(err) {
    ctx.log?.('WORKBENCH_RESTART',`cannot read exit evidence: ${err instanceof Error?err.message:err}`)
    return
  }
  for(const entry of entries) {
    if(entry.writerExited===true)continue
    try {
      const task=ctx.store.get(entry.taskId)
      if(task.error==='daemon_restarted'&&ctx.store.execution.last(task.id)?.runId===entry.runId) {
        ctx.store.update(task.id,'interrupted','writer_not_closed')
        ctx.store.addEvent(task.id,'system','CC 重启打断了关停；执行程序没确认退出，没有自动续接，请检查后确认它已经结束。')
      }
      dropRestartContinuation(ctx.stateDir,entry.taskId,entry.runId)
    } catch(err){ctx.log?.('WORKBENCH_RESTART',`${entry.taskId}: ${err instanceof Error?err.message:err}`)}
  }
}
export function recoverRestartContinuations(ctx: ServiceCtx, execute: Pick<ExecuteDomain, 'continueTask'> & Partial<Pick<ExecuteDomain, 'resumeUnstartedTask'>>): void {
  if (ctx.state.stopping) return
  quarantineRestartContinuations(ctx)
  let entries
  try { entries = readRestartContinuations(ctx.stateDir) }
  catch (err) { ctx.log?.('WORKBENCH_RESTART', `cannot consume continuations: ${err instanceof Error ? err.message : err}`); return }
  for (const entry of entries) {
    const drop=()=>dropRestartContinuation(ctx.stateDir,entry.taskId,entry.runId)
    try {
      if(entry.writerExited!==true)continue
      const task = ctx.store.get(entry.taskId)
      if (task.archivedAt !== null || task.error !== 'daemon_restarted' || !['cancelled', 'interrupted'].includes(task.status)) {drop();continue}
      if (ctx.state.runsByTask.has(task.id) || ctx.store.execution.last(task.id)?.runId !== entry.runId) {drop();continue}
      const lastUser = ctx.store.steps(task.id).filter(step => timelineKind(step) === 'user').at(-1)?.id ?? null
      if (lastUser !== entry.lastUserId) {drop();continue}
      let sameDirectory=false
      try {sameDirectory=canonicalProject(task.path)===task.path&&directoryIdentity(task.path)===entry.directoryIdentity}catch{/* 失去目录证据也不接 */}
      if(!sameDirectory){drop();ctx.store.addEvent(task.id,'system','CC 重启打断了上一轮；原文件夹已经移动或被替换，没有自动续接，请检查后继续。');continue}
      if (entry.pendingDecision) {
        drop()
        ctx.store.addEvent(task.id, 'system', 'CC 重启打断了上一轮；当时有待批准或待回答的事项，没有自动续接，请确认后继续。')
        continue
      }
      // 部署后的首次探测可能还没成功；尚未登记不算尝试，凭据留盘等 onRegister。
      if(!ctx.deps.registry.has(task.providerId))continue
      drop()
      const hex = createHash('sha256').update(`restart\0${entry.taskId}\0${entry.runId}`).digest('hex')
      const inputRequestId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
      try {
        if(entry.unstarted&&execute.resumeUnstartedTask)execute.resumeUnstartedTask(task.id,entry.runId,RESTART_RESUME_TEXT,inputRequestId)
        else execute.continueTask(task.id, RESTART_RESUME_TEXT, { inputRequestId })
      }
      catch (err) { ctx.store.addEvent(task.id, 'system', `CC 重启打断了上一轮；自动续接没有接上（${err instanceof Error ? err.message : err}），不会重复尝试，请确认后继续。`) }
    } catch (err) { ctx.log?.('WORKBENCH_RESTART', `${entry.taskId}: ${err instanceof Error ? err.message : err}`) }
  }
}
