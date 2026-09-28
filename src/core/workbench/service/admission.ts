/**
 * admission 域:执行者准入(登记项 / 免审门 / 输入校验)、续接判定、任务版本,以及
 * modelCatalog / prepareContinuation / acknowledgeUnattended 三个入口。
 * 从 service.ts 逐字搬来(spec 2026-09-27-workbench-service-split §3 第 7 项,提前到第 6 项前);只认 ctx。
 * 额度查询走 ctx.actions(quota 域);停机闸走 ctx.ensureAccepting。
 */
import { canonicalProject } from '../artifacts'
import { restartPreview, type Continuation } from '../continuation'
import { normalizeExecutionChoice } from '../execution-settings'
import { canResumeWorkbenchExecutor, isUnattendedExecutor, isWorkbenchExecutorCapabilities, isWorkbenchProviderId, requireWorkbenchInput, type WorkbenchExecutorCapabilities } from '../executor-capabilities'
import { snapshotHash } from '../native-adoption'
import { TERMINAL_TASK_STATUSES, type StoredTask } from '../store'
import type { Attachment } from '../attachments'
import type { AgentExecutionChoice, AgentModelCatalog } from '../../agent-provider'
import type { ServiceCtx } from './ctx'
import type { AdmittedProvider } from './types'

export interface AdmissionDomain {
  provider(id:string): AdmittedProvider
  requireInput(providerId:string,attachments:readonly unknown[],execution:AgentExecutionChoice,resume?:boolean): AdmittedProvider
  requireEntryInput(providerId:string,attachments:readonly Attachment[],execution:AgentExecutionChoice,text:string): void
  canResume(task:StoredTask): boolean
  continuation(task:StoredTask,execution?:AgentExecutionChoice): Continuation
  taskVersion(task:StoredTask): string
  modelCatalog(providerId:string,path:string): Promise<AgentModelCatalog>
  prepareContinuation(id:string,executionChoice?:unknown): Continuation
  acknowledgeUnattended(): number
}

export function makeAdmissionDomain(ctx:ServiceCtx):AdmissionDomain {
  const { store } = ctx
  function provider(id: string) {
    const entry=isWorkbenchProviderId(id)?ctx.deps.registry.get(id):null
    if(!entry||!isWorkbenchExecutorCapabilities(entry.opts.workbench))throw new Error('unavailable_provider')
    return entry as typeof entry&{opts:typeof entry.opts&{workbench:WorkbenchExecutorCapabilities}}
  }
  function requireInput(providerId:string,attachments:readonly unknown[],execution:AgentExecutionChoice,resume=false){
    const entry=provider(providerId)
    if(isUnattendedExecutor(entry.opts.workbench)&&(ctx.deps.unattendedAck?.get()??null)===null)throw new Error('unattended_ack_required')
    requireWorkbenchInput(entry.opts.workbench,{attachments,execution,resume})
    return entry
  }
  function requireEntryInput(providerId:string,attachments:readonly Attachment[],execution:AgentExecutionChoice,text:string){
    const entry=requireInput(providerId,attachments,execution)
    entry.opts.validateWorkbenchInput?.({text,attachments})
    if(ctx.actions.deref('admission').quotaExhausted(providerId))throw Error('provider_quota_exhausted')
  }
  function canResume(task:StoredTask):boolean {
    try {
      const entry=provider(task.providerId)
      return !!task.sessionId&&canResumeWorkbenchExecutor(entry.opts.workbench)&&!!entry.opts.canResume(task.path,task.sessionId)
    }
    catch { return false }
  }
  function continuation(task:StoredTask,execution:AgentExecutionChoice=store.execution.choice(task.id)):Continuation {
    const events=store.events(task.id)
    if (!events.some(event => event.kind==='user' || event.kind==='text')) return {mode:'new'}
    if (canResume(task)) return {mode:'resume'}
    return {mode:'restart_required',restart:restartPreview(task,events,execution,store.execution.choice(task.id))}
  }
  function taskVersion(task:StoredTask){return snapshotHash(JSON.stringify({updatedAt:task.updatedAt,status:task.status,sessionId:task.sessionId,events:store.events(task.id),source:store.source(task.id)?.firstDispatchedAt,execution:store.execution.choice(task.id)}))}
  async function modelCatalog(providerId:string,path:string):Promise<AgentModelCatalog>{
    const entry=provider(providerId),canonical=canonicalProject(path)
    if(!entry.opts.workbench.features.modelCatalog||!entry.provider.modelCatalog)throw Error('model_catalog_unavailable')
    // Discovery providers own one bounded lifecycle, including process cleanup.
    // A second race here would abandon (rather than cancel) their work.
    try{return await entry.provider.modelCatalog({alias:'workbench:model-catalog',path:canonical})}
    catch(error){throw Error(error instanceof Error&&error.message==='model_catalog_invalid'?'model_catalog_invalid':'model_catalog_unavailable')}
  }
  function prepareContinuation(id:string,executionChoice?:unknown):Continuation{
    ctx.ensureAccepting()
    const task=store.get(id)
    if(ctx.state.runsByTask.has(id)||!TERMINAL_TASK_STATUSES.includes(task.status))throw Error('workbench_busy')
    if(task.archivedAt!==null)throw Error('workbench_archived')
    if(store.source(id)?.firstDispatchedAt===null)throw Error('external_close_confirmation_required')
    return continuation(task,normalizeExecutionChoice(executionChoice,store.execution.choice(id)))
  }
  /** 免审执行者的一次性确认;不接 `unattendedAck`(老接线)时永远拒绝 —— 免审执行者只能停在
   *  「要求确认」,不能悄悄放行。 */
  function acknowledgeUnattended():number {
    if(!ctx.deps.unattendedAck)throw new Error('unattended_ack_unavailable')
    const at=Date.now()
    ctx.deps.unattendedAck.set(at)
    return at
  }

  return { provider,requireInput,requireEntryInput,canResume,continuation,taskVersion,modelCatalog,prepareContinuation,acknowledgeUnattended }
}
