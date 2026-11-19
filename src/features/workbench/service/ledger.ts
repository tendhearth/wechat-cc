import {readTopicBrief} from './topic-brief'
import type {MatterNotesQuery,MatterAgent,MatterNote} from '../../../ports/matters'
import {canonicalProject} from '../../../adapters/workbench/artifacts'
import {publicTask} from '../../../adapters/store/workbench/store'
import {PROVIDER_EXECUTION_CHOICE} from '../../../adapters/store/workbench/execution-settings'
import {assertNotRewindBlocked} from '../../../adapters/store/workbench/rewind-store'
import type {ServiceCtx} from './ctx'
import type {ExecuteDomain} from './execute'
import type {LifecycleDomain} from './lifecycle'
import type {AdmissionDomain} from './admission'
import {directoryIdentity} from './directory-identity'
import {seedLedger} from './ledger-completion'
import {checkedText} from './checked-text'
import type {EntryDomain} from './entry'
import type {makeViewDomain} from './view'
import {matterApprovals} from './matter-approvals'
import {MatterPlanRequest} from '../../../../packages/protocol/src/desktop-api'
import {resolvePlanTarget,resolvePlanLegs,PlanInputError,planRequestId,type PlanLegs,type PlanConversation,type PlanCaller,type MatterPlanInput} from '../../../adapters/workbench/matter-plan-input'
import {projectRegistrationId} from '../../../adapters/workbench/project-catalog'

export type {MatterPlanInput} from '../../../adapters/workbench/matter-plan-input'
export interface AutoRelayHandoff {from:number|null;to:number;beforeStart:()=>void;ownerResume?:boolean;accepted?:()=>void}
export class RegisteredProjectDispatchError extends Error {
  constructor(cause:unknown){super(cause instanceof Error?cause.message:'',{cause})}
}

export function makeLedgerDomain(ctx:ServiceCtx,d:{execute:ExecuteDomain;lifecycle:LifecycleDomain;admission:AdmissionDomain;entry:EntryDomain;view:ReturnType<typeof makeViewDomain>}){
  const {store,state}=ctx,inFlight=new Set<string>()
  const approvals=matterApprovals()
  const scopes=new Map<string,string>()
  const conversation=(caller:PlanCaller)=>{
    const current=ctx.deps.planConversation?.(caller)??undefined
    if(current){
      const key=JSON.stringify([caller.chatId,caller.provider??caller.sessionKey?.split('/')[0]])
      const previous=scopes.get(key)
      if(previous&&previous!==current.scope)approvals.drop(previous)
      scopes.set(key,current.scope)
    }
    return current
  }
  const planPlaces=()=>ctx.deps.planPlaces?.()??[]
  function prepare(input:MatterPlanInput,context?:PlanConversation,preview=false){
    const parsed=MatterPlanRequest.safeParse(input)
    if(!parsed.success)throw Error('invalid_matter_plan')
    const normalized=parsed.data
    const bound=context&&approvals.get(context.scope,'mcp__wechat__matter_plan',normalized)
    const prior=normalized.requestId&&store.entryRequests.get(ctx.deps.ownerChatId()??'',normalized.requestId.toLowerCase())
    const first=normalized.legs[0]
    const replayLegs=prior&&prior.phase==='accepted'&&normalized.legs.length===1&&first&&first.executor===undefined
      ? [{executor:prior.providerId,brief:first.brief}]
      : undefined
    if(bound?.target&&(preview||bound.approved))return {...normalized,...bound.target,legs:bound.target.registrationPath?bound.target.legs:replayLegs??bound.target.legs}
    const target=normalized.target
    if(prior&&prior.phase==='accepted'&&!normalized.project&&target&&(target.kind==='managed'&&!normalized.isolation&&!normalized.base||target.kind==='project'&&target.projectId)){
      return {...normalized,legs:replayLegs??resolvePlanLegs(normalized,d.entry.planExecutors),target:target.kind==='managed'?target:{...target,projectId:target.projectId!,...(normalized.isolation?{isolation:normalized.isolation}:{}),...(normalized.base?{base:normalized.base}:{})},projectName:'',projectPath:''}
    }
    const owner=ctx.deps.ownerChatId()??''
    const resolved=resolvePlanTarget(normalized,d.entry.entryOptions({ownerKey:owner,surface:'desktop'}).projects,context?.path,planPlaces,owner)
    return {...normalized,...resolved,legs:replayLegs??resolvePlanLegs(normalized,d.entry.planExecutors)}
  }
  function requirePlanLegs(legs:PlanLegs){
    try{
      for(const leg of legs)d.admission.requireEntryInput(leg.executor,[],PROVIDER_EXECUTION_CHOICE,leg.brief)
    }catch(error){
      if(error instanceof Error&&error.message==='unavailable_provider')throw new PlanInputError(error.message,undefined,d.entry.availableExecutors())
      throw error
    }
  }
  return {
    planPlaces,
    matterPlanPreview(input:MatterPlanInput,caller:PlanCaller){
      if(!caller.chatId||caller.chatId!==ctx.deps.ownerChatId())throw Error('matter_ledger_forbidden')
      const context=conversation(caller)
      if(!context)throw Error('matter_conversation_unavailable')
      const prepared=prepare(input,context,true)
      requirePlanLegs(prepared.legs)
      if(prepared.registrationPath)d.view.validateProject({path:prepared.projectPath,name:prepared.projectName,providerId:prepared.legs[0]!.executor},prepared.registrationPath)
      approvals.preview(context.scope,input,prepared)
      return prepared
    },
    noteMatterApproval(tool:string,input:unknown,caller:PlanCaller){const context=conversation(caller);if(context)approvals.approve(context.scope,tool,input)},
    matterApprovalConsume(tool:string,input:unknown,caller:PlanCaller){const context=conversation(caller);if(context)approvals.consume(context.scope,tool,input)},
    matterApprovalStatus(tool:string,input:unknown,caller:PlanCaller){const context=conversation(caller);return !!context&&approvals.get(context.scope,tool,input)?.approved===true},
    async matterContext(key:string|undefined,requested?:string){
      if(key?.startsWith('terminal-participation/'))throw Error('matter_ledger_forbidden')
      const id=store.ledger.bound(key,requested),task=store.get(id)
      if(!store.ledger.enabled(id))throw Error('matter_ledger_forbidden')
      const text=store.events(id).filter(e=>e.kind==='user').at(-1)?.text??''
      const context=await readTopicBrief(ctx.deps.topicBrief,task,text)
      return {context:context??'',...(!context?{message:'没有相关话题'}:{})}
    },
    matterNotes(key:string|undefined,requested?:string,q?:MatterNotesQuery){
      const page=store.ledger.page(store.ledger.bound(key,requested),q)
      if(key?.startsWith('terminal-participation/'))store.ledger.terminals.connected(key)
      return page
    },
    matterNote(key:string|undefined,text:string){
      if(key?.startsWith('terminal-participation/')){
        const p=store.ledger.terminals.bound(key)
        if(typeof text!=='string'||!text.trim()||text.length>1000)throw Error('invalid_matter_note')
        store.atomic(()=>{store.ledger.note(p.matterId,p.runId,p.author,text);ctx.deps.matters?.touch(p.matterId)})
        store.ledger.terminals.connected(key)
        store.ledger.terminals.touch(p.matterId)
        return {ok:true as const}
      }
      const id=store.ledger.bound(key),run=state.runsByTask.get(id)
      if(!store.ledger.enabled(id)||!run||run.cancelled||run.finishing||run.uncertain)throw Error('matter_session_ended')
      if(typeof text!=='string'||!text.trim()||text.length>1000)throw Error('invalid_matter_note')
      store.atomic(()=>{store.ledger.note(id,run.ledgerRunId??run.identity,run.task.providerId,text,run.turn?.id);store.bump(id)})
      return {ok:true as const}
    },
    ledgerOwned:(id:string,owner:string|null)=>!!owner&&(ctx.deps.matters?.get(id)?.ownerChatId??store.get(id).ownerChatId)===owner,
    ledgerRead:(id:string):{agentRuns?:MatterAgent[];notes?:MatterNote[];notesTotal?:number;terminalParticipants?:import('../../../ports/matters').TerminalParticipation[]}=>(store.ledger.enabled(id)?{...(store.ledger.terminals.list(id).length?{terminalParticipants:store.ledger.terminals.list(id)}:{}),agentRuns:store.ledger.projectedAgents(id),...store.ledger.recent(id)}:{}),
    async matterPlan(input:MatterPlanInput,context?:PlanConversation){
      const owner=ctx.deps.ownerChatId()
      if(!owner)throw Error('matter_ledger_forbidden')
      const prepared=prepare(input,context),legs=prepared.legs
      const registrationPath=prepared.registrationPath
      if(registrationPath){
        const bound=context&&approvals.get(context.scope,'mcp__wechat__matter_plan',input)
        if(!bound?.approved||!bound.target?.registrationPath)throw Error('matter_project_registration_requires_approval')
      }
      if(!input.requestId&&!context?.scope)throw Error('matter_conversation_unavailable')
      const requestId=input.requestId??planRequestId(JSON.stringify([owner,context!.scope]),prepared)
      // Accepted receipts replay before mutable provider admission; createEntry still checks the complete hash.
      if(!d.entry.entryReceipt(requestId,{ownerKey:owner,surface:'desktop'}))requirePlanLegs(legs)
      const first=prepared.legs[0]!
      const target=prepared.target
      let projectRegistered=false
      if(registrationPath&&target.kind==='project'){
        ctx.ensureAccepting()
        const project={path:prepared.projectPath,name:prepared.projectName,providerId:first.executor}
        if(projectRegistrationId(owner,project.path)!==target.projectId)throw Error('matter_place_changed')
        if(store.projects().some(p=>p.path===registrationPath))d.view.validateProject(project,registrationPath)
        else {
          d.view.addProject(project,registrationPath)
          projectRegistered=true
        }
      }
      try{
        return await d.entry.createEntry({requestId,target,title:prepared.title,text:first.brief,providerId:first.executor},{ownerKey:owner,surface:'desktop'},
          {identity:JSON.stringify(legs),persist:(task,runId)=>{
            if(ctx.deps.ownerChatId()!==owner)throw Error('matter_ledger_forbidden')
            // A single executor is an ordinary chat delegation, without a relay ledger or plan.
            if(legs.length===1)return
            store.ledger.start(task.id,runId,first.executor,first.brief)
            store.plans.approve(task.id,legs,runId)
            store.ledger.plan(task.id,legs)
          }})
      }catch(error){
        if(projectRegistered)throw new RegisteredProjectDispatchError(error)
        throw error
      }
    },
    async matterHandoff(id:string,executor:string,brief:string,automatic?:AutoRelayHandoff){
      ctx.ensureAccepting()
      if(inFlight.has(id))throw Error('workbench_busy')
      inFlight.add(id)
      try{
        const text=checkedText(brief),owner=ctx.deps.ownerChatId()
        const check=()=>{
          const task=store.get(id)
          if(!owner||ctx.deps.ownerChatId()!==owner||task.ownerChatId!==owner||store.taskMatterId(id)!==id)throw Error('matter_ledger_forbidden')
          if(task.archivedAt!==null)throw Error('workbench_archived')
          if(task.error==='writer_not_closed')throw Error('writer_not_closed')
          if(store.worktrees.get(id)?.removedAt!=null)throw Error('worktree_removed')
          if(store.source(id)?.firstDispatchedAt===null)throw Error('external_close_confirmation_required')
          if(store.liveInputs.count(id)>0)throw Error('workbench_busy')
          assertNotRewindBlocked(store.rewinds,id)
          if(canonicalProject(task.path)!==task.path)throw Error('invalid_path')
          d.admission.requireEntryInput(executor,[],PROVIDER_EXECUTION_CHOICE,text)
          return task
        }
        let task=check()
        const prior=state.runsByTask.get(id)
        if(prior){
          if(!d.lifecycle.quiet(prior)||prior.cancelled||prior.finishing||prior.uncertain)throw Error('workbench_busy')
          prior.relayClosing=true
          await d.lifecycle.cancel(id,prior.identity)
          await prior.done
        }
        ctx.ensureAccepting()
        task=check()
        if(state.runsByTask.has(id)||state.writerOrphans.has(id))throw Error('workbench_busy')
        const identity=directoryIdentity(task.path)
        if(prior&&identity!==prior.directoryIdentity)throw Error('invalid_path')
        let activate:(()=>void)|undefined
        let planCancelled=false
        const view=store.atomic(()=>{
          automatic?.beforeStart()
          if(!store.ledger.enabled(id))seedLedger(ctx,task,prior)
          store.switchExecutor(id,executor)
          if(!automatic)planCancelled=store.plans.cancel(id)
          return d.execute.start(store.get(id),text,identity,{mode:'new'},undefined,undefined,undefined,undefined,[],undefined,PROVIDER_EXECUTION_CHOICE,{ledgerOpening:true,persist:runId=>{if(automatic)store.plans.advance(id,automatic.from,automatic.to,runId,automatic.ownerResume)},activate:fn=>{activate=fn}})
        })
        // Once accepted, even a queued run must never be recorded as an unstarted pending leg.
        automatic?.accepted?.()
        activate?.()
        return {...view,...publicTask(store.get(id)),...(planCancelled?{planCancelled:true,notice:'拆法已作废'}:{})}
      }finally{inFlight.delete(id)}
    },
  }
}
