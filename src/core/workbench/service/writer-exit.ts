/**
 * 「没确认退出」的退出证据(2026-10-06):执行程序的进程组还在不在。lifecycle(守望 / 主人确认)与
 * view(任务页给不给「我确认它已经结束」)共用这一处。
 */
import type { Active } from './state'
import type { ServiceCtx } from './ctx'

export function writerGroupsOf(running:Active):number[] {
  try { return [...(running.session?.processGroups?.() ?? [])] } catch { return [] }
}
export function groupAlive(ctx:ServiceCtx,group:number):boolean {
  if (ctx.deps.writerGroupAlive) return ctx.deps.writerGroupAlive(group)
  if (process.platform === 'win32') return true
  // 只有 ESRCH 算「没了」:EPERM(别的用户 / 僵尸组)宁可当还在。
  try { process.kill(-group,0); return true } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
}
/** 这条任务眼下已知的进程组:重启前留下的占用,或本进程里关不掉的那条 run。 */
export function knownWriterGroups(ctx:ServiceCtx,taskId:string):number[] {
  const orphan=ctx.state.writerOrphans.get(taskId)
  if (orphan) return orphan.groups
  const running=ctx.state.runsByTask.get(taskId)
  return running?.uncertain ? writerGroupsOf(running) : []
}
export const writerAlive=(ctx:ServiceCtx,taskId:string)=>knownWriterGroups(ctx,taskId).some(g=>groupAlive(ctx,g))
