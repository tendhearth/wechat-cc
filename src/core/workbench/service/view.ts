/**
 * view 域:主人眼里的进度(阶段 / 等待行 / 任务视图)以及 attention / projects / addProject / list / detail 五个只读入口。
 * 从 service.ts 逐字搬来(spec 2026-09-27-workbench-service-split §3 第 7 项);只认 ctx。
 * 唯一的文字改动:waitingFor 里的 quiet(holder) 写成 isReplied(holder)——quiet 本来就是 isReplied 的别名(service.ts 仍保留给 lifecycle 用)。
 * 跨域三处走 ctx.actions:addProject 的 provider(admission)、list 的 quotaExhausted(quota)、detail 的 continuation(admission)。
 */
import { canonicalProject } from '../artifacts'
import { readableExecutionEvent } from '../codex-execution-error'
import { isWorkbenchExecutorCapabilities, isWorkbenchProviderId } from '../executor-capabilities'
import { makeProjectCatalog } from '../project-catalog'
import { findPathBlocker } from '../scheduler'
import { TERMINAL_TASK_STATUSES, type Task, type WorkbenchListQuery } from '../store'
import type { AgentRuntimeSnapshot } from '../../agent-provider'
import type { TaskWaitingFor } from '../wechat-types'
import type { WorkbenchPhase, WorkbenchTaskView } from './types'
import type { Active } from './state'
import type { ServiceCtx } from './ctx'
import type { PendingWorkbenchPermission } from '../permissions'
import type { PendingUserInput } from '../user-input'
import type { QuotaHandoffView } from './types'

/** attention 里「第一件待决」原文的上限(字符)。桌面「N 件事等你」一行放得下的量;不在这里截就会把整段命令塞进轮询。 */
export const ATTENTION_TEXT_MAX = 120
const oneLine=(s:string):string=>{const t=s.replace(/\s+/g,' ').trim();return t.length>ATTENTION_TEXT_MAX?t.slice(0,ATTENTION_TEXT_MAX-1)+'…':t}
export interface AttentionFirst { kind:'permission'|'question'; text:string }
/** 第一件待决(权限优先、最早的那件),写法与手机 approvals 话题同一个:权限「工具: 说明」,提问取第一问。 */
function firstPending(permissions:readonly PendingWorkbenchPermission[],questions:readonly PendingUserInput[]):AttentionFirst|null {
  const p=[...permissions].sort((a,b)=>(a.createdAt??0)-(b.createdAt??0))[0]
  if(p){const text=oneLine([p.tool,p.description].filter(x=>typeof x==='string'&&x.trim()).join(': '));if(text)return{kind:'permission',text}}
  const q=[...questions].sort((a,b)=>(a.createdAt??0)-(b.createdAt??0))[0]
  const text=q?oneLine(q.questions?.[0]?.question??''):''
  return text?{kind:'question',text}:null
}

export function makeViewDomain(ctx:ServiceCtx, queries?:{quotaHandoff(id:string):QuotaHandoffView|null}) {
  const { store, state } = ctx
  /** 当前占着文件夹的 run。 */
  const held=()=>[...state.reservations.values()]
  function waitingFor(running:Active):TaskWaitingFor|null {
    if (running.state !== 'queued') return null
    const earlier=state.queue.filter(item => item.order < running.order && item.state === 'queued')
    const blocked=findPathBlocker(running,[...held(),...earlier])
    if (!blocked) return null
    const holder=state.runsByTask.get(blocked.taskId)
    // 找不到持有者是不该发生的时序缝隙;宁可继续说「还在写」,也不能凭空报一个假的倒计时。
    return {...blocked,holderWriting:!holder||!isReplied(holder),closeInMs:holder?.idleClose?Math.max(0,holder.idleClose.at-Date.now()):null}
  }
  function runtimeSnapshot(running:Active|undefined):AgentRuntimeSnapshot|undefined {
    const runtime=running?.session?.workbenchRuntime
    return runtime?{...runtime.snapshot()}:undefined
  }
  function inputMode(running:Active):'steer'|'send'|'queue' {
    return runtimeSnapshot(running)?.input??(running.session?.steer?'steer':'queue')
  }
  /** 本轮做完、会话闲着、没有子任务在写、也没有在等主人拍板 —— 只差主人下一句话。 */
  function isReplied(running:Active):boolean {
    if (running.cancelled||running.finishing||running.uncertain) return false
    const snapshot=runtimeSnapshot(running)
    return !!snapshot&&snapshot.retained&&snapshot.foreground==='idle'&&snapshot.backgroundCount===0
      &&running.permissions.pending().length===0&&running.questions.pending().length===0
  }
  function phaseOf(task:Task, running:Active|undefined):WorkbenchPhase {
    switch (task.status) {
      case 'queued': return 'queued'
      case 'running': case 'cancelling': return running&&isReplied(running)?'replied':'working'
      case 'completed': return 'replied'
      case 'failed': case 'cancelled': case 'interrupted': return task.status
    }
  }
  function taskView(task:Task, includePermissions=false):WorkbenchTaskView {
    const running=state.runsByTask.get(task.id)
    const runtime=runtimeSnapshot(running)
    return {
      ...task,
      phase:phaseOf(task,running),
      ...(runtime?{runtime}:{}),
      ...(!running&&TERMINAL_TASK_STATUSES.includes(task.status)&&store.source(task.id)?.firstDispatchedAt===null?{importedOnly:true}:{}),
      canArchive:TERMINAL_TASK_STATUSES.includes(task.status) && !running && task.error!=='writer_not_closed',
      waitingFor:running ? waitingFor(running) : null,
      ...(includePermissions ? { pendingPermissionCount:running?.permissions.pending().length ?? 0,pendingQuestionCount:running?.questions.pending().length ?? 0 } : {}),
    }
  }
  function attention(){
    const tasks=Array.from(state.runsByTask.values()).flatMap(run=>{
      const permissions=run.permissions.pending(),questions=run.questions.pending()
      if(!permissions.length&&!questions.length)return[]
      return[{id:run.taskId,title:run.title,providerId:run.task.providerId,pendingPermissionCount:permissions.length,pendingQuestionCount:questions.length,first:firstPending(permissions,questions),attentionKey:JSON.stringify([...permissions,...questions].map(q=>q.id).sort())}]
    })
    return{tasks}
  }
  function projects(){
    const ownerChatId=ctx.deps.ownerChatId();if(!ownerChatId)return[]
    const providers=ctx.deps.registry.list().filter(id=>isWorkbenchProviderId(id)&&isWorkbenchExecutorCapabilities(ctx.deps.registry.get(id)?.opts.workbench))
    return makeProjectCatalog({ownerChatId,registered:ctx.deps.registeredProjects?.()??[],known:store.ownedProjects(ownerChatId,providers),providers,defaultProvider:ctx.deps.defaultProvider})
  }
  function addProject(input:{path:string;name?:string;providerId:string}) {
    if(typeof input.path!=='string'||input.path.length>4096||typeof input.providerId!=='string'||(input.name!==undefined&&(typeof input.name!=='string'||!input.name.trim()||input.name.length>100)))throw Error('invalid_request')
    ctx.actions.deref('view').provider(input.providerId)
    return store.addProject({...input,path:canonicalProject(input.path)})
  }
  function list(query:WorkbenchListQuery={}) {
    const providers=ctx.deps.registry.list().flatMap(id=>{const p=ctx.deps.registry.get(id);return isWorkbenchProviderId(id)&&p&&isWorkbenchExecutorCapabilities(p.opts.workbench)?[{id,displayName:p.opts.displayName,capabilities:structuredClone(p.opts.workbench),quota:ctx.actions.deref('view').quotaExhausted(id),usage:ctx.deps.usage?.(id)??null}]:[]})
    const result=store.listPage(query)
    const projects=store.projects()
    const projectProviders=Object.fromEntries(projects.map(project=>[project.path,store.projectProvider(project.path)??project.providerId]))
    return {projects,tasks:result.tasks.map(task => taskView(task,true)),page:result.page,projectProviders,providers,historyProviders:Object.keys(ctx.deps.nativeHistory??{}),defaultProvider:providers.find(p=>p.id===ctx.deps.defaultProvider)?.id ?? providers[0]?.id ?? null,canWechat:!!ctx.deps.ownerChatId(),unattendedAcknowledgedAt:ctx.deps.unattendedAck?.get()??null}
  }
  function detail(id:string,options:{since?:number}={}) {
    const detail=store.detail(id,options),running=state.runsByTask.get(id)
    const runtime=runtimeSnapshot(running)
    const subscription=store.wechatNotifications.subscription(id)
    const wechatNotifications={enabled:!!subscription?.enabled,notices:store.wechatNotifications.list(id).slice(-10).map(({id,runId,kind,status,reason,createdAt})=>({id,runId,kind,status,reason,createdAt}))}
    const result={...detail,events:detail.events.map(readableExecutionEvent),wechatNotifications,quotaHandoff:queries?.quotaHandoff(id)??null,...(runtime?{runtime}:{}),execution:store.execution.choice(id),lastExecution:store.execution.last(id),attachments:store.attachments.list(id),task:taskView(detail.task,true),inputs:store.liveInputs.list(id),questions:running?.questions.pending()??[],
      // The timeline stays live through cancellation and process cleanup;
      // accepting supplemental input is a separate, narrower capability.
      ...(running?{runId:running.identity}:{}),
      ...(running&&!running.cancelled&&!running.finishing&&!running.uncertain?{inputMode:inputMode(running)}:{}),
      permissions:running?.permissions.pending() ?? [],...(!running ? {continuation:ctx.actions.deref('view').continuation(store.get(id)),...(store.source(id)?.firstDispatchedAt===null?{requiresExternalClose:true}:{})} : {})}
    ctx.hub.touched(id,detail.version)
    return result
  }

  return { held,waitingFor,runtimeSnapshot,inputMode,isReplied,phaseOf,taskView,attention,projects,addProject,list,detail }
}
export type ViewDomain = ReturnType<typeof makeViewDomain>
