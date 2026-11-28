import {candidateResult,candidateStatus,candidateTerminal,compareCandidates,groupSettled} from '../../../domain/matter-parallel'
import {redactSecrets} from '../../../domain/cli-transcript'
import {planRequestId} from '../../../adapters/workbench/matter-plan-input'
import {stepPayload,timelineKind} from '../../../adapters/store/workbench/store'
import {git,worktreeDirty,worktreeNetChanges,type WorktreeStart} from '../../../adapters/git/worktree-workspaces'
import type {PlanCandidate} from '../../../adapters/store/matter-plans'
import type {EntryDomain} from './entry'
import type {ServiceCtx} from './ctx'
import type {WorktreeActionResult} from './worktree'
import type {Active} from './state'

const sanitize=(text:string)=>redactSecrets(text).replace(/[\p{Cc}\p{Cf}]/gu,' ').trim()

export function makeParallelDomain(ctx:ServiceCtx,entry:EntryDomain){
  const {store,state}=ctx
  const launching=new Map<string,Promise<void>>()
  function enqueueComparison(id:string,position:number,revision:number,text:string){
    const sink=ctx.deps.reports
    if(!sink?.enqueueComparison)return
    void Promise.resolve().then(()=>sink.enqueueComparison!(id,text,{position,revision})).then(
      ()=>store.plans.comparisonEnqueued(id,position,revision),
    ).catch(error=>ctx.log?.('MATTER_PARALLEL',`${id}/${position}: comparison delivery: ${String(error)}`))
  }
  function snapshot(taskId:string):Pick<NonNullable<PlanCandidate['result']>,'files'|'partial'|'snapshot'>{
    const tree=store.worktrees.get(taskId)
    if(!tree?.start||tree.removedAt!==null)return {files:null,partial:true}
    try{
      const stats=worktreeNetChanges(tree.root,tree.start.sha)
      return {...stats,files:stats.files?.map(file=>({...file,path:sanitize(file.path)}))??null}
    }catch{return {files:null,partial:true}}
  }
  function report(id:string,position:number){
    const group=store.plans.candidates(id,position)
    if(!groupSettled(group)||group.some(member=>member.taskId&&store.liveInputs.count(member.taskId)>0))return
    const title=sanitize(store.get(id).title)
    const saved=store.atomic(()=>{
      const previous=store.plans.comparison(id,position)
      if(previous?.text)return null
      for(const member of group)if(member.taskId&&!member.result){
        member.result={...candidateResult('',null),...snapshot(member.taskId)}
        store.plans.refreshCandidate(member,member.result)
      }
      const text=compareCandidates(title,position,group.map(member=>({
        ...member,name:sanitize(ctx.deps.registry.namesOf(member.executor).name),
      })),previous?.revision??1)
      const intent=store.plans.saveComparison(id,position,text)
      if(!intent)return null
      if(!group.some(member=>member.taskId))store.plans.stop(id,position,'leg_failed')
      store.addEvent(id,'system',text)
      return {...intent,text}
    })
    if(!saved)return
    ctx.hub.bumped(id)
    enqueueComparison(id,position,saved.revision,saved.text)
  }
  function settle(member:PlanCandidate,status:PlanCandidate['status'],result:PlanCandidate['result']){
    const {matterId,position,ordinal}=member
    const changed=store.atomic(()=>{
      if(!store.plans.settleCandidate(matterId,position,ordinal,status,result))return false
      store.bump(matterId)
      return true
    })
    if(!changed)return
    ctx.hub.bumped(matterId)
    if(!state.stopping&&candidateTerminal(status)&&store.plans.get(matterId)?.state==='approved')report(matterId,position)
  }
  function afterTurn(running:Active,status:string,question:boolean,ownerInputQueued:boolean):boolean{
    const member=store.plans.candidateForTask(running.taskId)
    if(!member||member.runId!==running.ledgerRunId)return false
    if(candidateTerminal(member.status))return true
    if(ownerInputQueued&&status==='completed'&&!running.cancelled)return true
    if(running.cancelled&&(!running.closedWhileReplied||running.ownerStopped))status='cancelled'
    const steps=store.steps(running.taskId).filter(step=>stepPayload(step).runId===running.identity)
    const lastInput=steps.findLast(step=>timelineKind(step)==='user')?.seq??0
    // An idle snapshot can close the stored turn before the buffered result.
    const reply=steps.findLast(step=>step.seq>lastInput&&timelineKind(step)==='text')
    const text=reply?stepPayload(reply).text:''
    const result={...candidateResult(text,null),...snapshot(running.taskId)}
    result.tests=result.tests.map(sanitize).filter(Boolean)
    settle(member,candidateStatus(state.stopping?'interrupted':running.uncertain?'interrupted':status,text,question,!running.publicFinished),result)
    return true
  }
  function launch(id:string,position:number,target:Parameters<EntryDomain['createEntry']>[0]['target'],start:WorktreeStart):Promise<void>{
    const key=`${id}:${position}`,inFlight=launching.get(key)
    if(inFlight)return inFlight
    const plan=store.plans.get(id),leg=plan?.legs.find(l=>l.position===position)
    if(plan?.state!=='approved'||leg?.state!=='running')return Promise.resolve()
    const task=store.get(id),owner=task.ownerChatId
    if(!owner||ctx.deps.ownerChatId()!==owner)throw Error('matter_ledger_forbidden')
    const work=Promise.all(store.plans.candidates(id,position).filter(m=>!m.taskId&&m.status==='queued').map(async member=>{
      const requestId=planRequestId(`parallel:${id}:${position}:${member.ordinal}`,{title:task.title,target,legs:[{executor:member.executor,brief:leg.brief}]})
      try{
        await entry.createEntry({requestId,target,title:task.title,text:leg.brief,providerId:member.executor},{ownerKey:owner,surface:'desktop'},{
          identity:JSON.stringify([id,position,member.ordinal,start.sha]),parallelStart:start,
          persist:(candidate,runId)=>{
            if(store.plans.get(id)?.state!=='approved'||store.get(id).archivedAt!==null)throw Error('matter_plan_stale')
            store.plans.bindCandidate(id,position,member.ordinal,candidate.id,runId)
            store.ledger.start(id,runId,member.executor,leg.brief)
            store.bump(id)
          },
        })
        ctx.hub.bumped(id)
      }catch(error){
        ctx.log?.('MATTER_PARALLEL',`${id}/${position}/${member.ordinal}: ${error instanceof Error?error.message:'launch failed'}`)
        settle(member,state.stopping?'interrupted':'failed',null)
      }
    })).then(()=>{}).finally(()=>launching.delete(key))
    launching.set(key,work)
    return work
  }
  function forkStart(taskId:string):{target:Parameters<EntryDomain['createEntry']>[0]['target'];start:WorktreeStart}{
    const tree=store.worktrees.get(taskId)
    const prior=store.entryRequests.forMatter(taskId)?.target
    if(!tree||tree.removedAt!==null||prior?.kind!=='project')throw Error('matter_parallel_requires_project')
    if(worktreeDirty(tree.root))throw Error('matter_parallel_uncommitted')
    const sha=git(tree.root,['rev-parse','--verify','HEAD^{commit}'])
    return {target:{kind:'project',projectId:prior.projectId,isolation:'worktree'},start:{base:tree.branch,sha,notices:[]}}
  }
  async function choose(taskId:string,merge:(sha?:string)=>WorktreeActionResult,resume:(id:string)=>void,record?:(result:WorktreeActionResult)=>void){
    const member=store.plans.candidateForTask(taskId)
    if(!member||member.chosen){
      const merged=merge()
      record?.(merged)
      return merged
    }
    const {matterId:id,position,ordinal}=member
    const owner=ctx.deps.ownerChatId()
    if(!owner||store.get(id).ownerChatId!==owner||store.get(taskId).ownerChatId!==owner)throw Error('matter_ledger_forbidden')
    ctx.ensureAccepting()
    const plan=store.plans.get(id)
    const group=store.plans.candidates(id,position)
    if(store.get(id).archivedAt!==null||plan?.state!=='approved'||plan.legs.find(l=>l.position===position)?.state!=='running'||group.some(m=>m.chosen))throw Error('matter_parallel_not_ready')
    for(const version of group)if(version.taskId&&store.liveInputs.count(version.taskId)>0){
      store.atomic(()=>{
        store.plans.reopenCandidate(version.taskId!,version.runId!)
        store.bump(id)
      })
      ctx.hub.bumped(id)
      throw Error('matter_parallel_not_ready')
    }
    if(!groupSettled(group)||!store.plans.comparison(id,position)?.text)throw Error('matter_parallel_not_ready')
    const current=snapshot(taskId)
    if(!current.snapshot)throw Error(current.files?'worktree_uncommitted':'matter_parallel_not_ready')
    if(member.result?.snapshot!==current.snapshot){
      store.atomic(()=>store.plans.refreshCandidate(member,{...candidateResult('',null),...member.result,...current}))
      report(id,position)
      throw Error('matter_parallel_snapshot_changed')
    }
    const merged=store.atomic(()=>{
      const result=merge(current.snapshot)
      store.plans.choose(id,position,ordinal)
      store.ledger.selection(id,member.runId!,`主人选定 ${member.executor} 的版本。接着在它的工作区 ${store.get(taskId).path} 做。`)
      store.bump(id)
      record?.(result)
      return result
    })
    ctx.hub.bumped(id)
    resume(id)
    return merged
  }
  function choiceTask(owner:string,name:string,target?:string,revision?:number){
    if(!target)throw Error('matter_parallel_choice_ambiguous')
    const candidate=store.plans.candidateForTask(target)
    const id=candidate?.matterId??target
    // A root task without its own membership is usable only when its comparison
    // identifies a single position, including past comparisons.
    const positions=candidate?[candidate.position]:[...new Set(store.plans.candidates(id).map(m=>m.position))]
    if(positions.length!==1)throw Error('matter_parallel_choice_ambiguous')
    const position=positions[0]!
    const plan=store.plans.get(id)
    if(!plan||store.get(id).ownerChatId!==owner)throw Error('matter_parallel_choice_ambiguous')
    if(plan.state!=='approved'||plan.legs.find(leg=>leg.position===position)?.state!=='running')throw Error('matter_parallel_not_ready')
    if(revision!==undefined&&store.plans.comparison(id,position)?.revision!==revision)throw Error('matter_parallel_snapshot_changed')
    const matches=store.plans.candidates(id,position).filter(member=>
      member.executor.toLowerCase()===name.toLowerCase()||ctx.deps.registry.namesOf(member.executor).name.toLowerCase()===name.toLowerCase())
    if(matches.length!==1)throw Error('matter_parallel_choice_ambiguous')
    if(!matches[0]?.taskId)throw Error('matter_parallel_not_ready')
    return matches[0].taskId
  }
  function recoverReports(){
    const owner=ctx.deps.ownerChatId()
    if(!owner)return
    // Recover already committed intents before composing any new comparisons.
    for(const {matterId,position,revision,text} of store.plans.comparisonIntents(owner))enqueueComparison(matterId,position,revision,text)
    for(const group of store.plans.pendingChoices(owner))report(group.matterId,group.position)
  }
  return {afterTurn,launch,forkStart,choose,choiceTask,recoverReports}
}
