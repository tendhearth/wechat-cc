import {decideRelay,decideResume,HELD_AFTER_COMPLETION,type RelayInput,type RelayStop} from '../../../domain/relay-decision'
import type {PlanLeg} from '../../../adapters/store/matter-plans'
import {PROVIDER_EXECUTION_CHOICE} from '../../../adapters/store/workbench/execution-settings'
import {stepPayload,timelineKind} from '../../../adapters/store/workbench/store'
import {canonicalProject} from '../../../adapters/workbench/artifacts'
import {providerDisplayName} from '../../../domain/provider-display-names'
import {redactSecrets} from '../../../domain/cli-transcript'
import {directoryIdentity} from './directory-identity'
import type {ServiceCtx} from './ctx'
import type {AdmissionDomain} from './admission'
import type {makeLedgerDomain} from './ledger'
import type {RelayTurnHook,RelayResume} from './relay-events'
import {trackPreparation,type Active} from './state'

const REASONS:Record<RelayStop,string>={
  plan_inactive:'拆法已经结束或作废',plan_stale:'这份拆法已经批准超过七天',not_plan_leg:'这一轮已经不属于原来的拆法',
  leg_failed:'这一轮没做成',leg_cancelled:'这一轮停下了',leg_interrupted:'这一轮被中断',leg_uncertain:'还没确认执行程序退出',
  leg_asked:'正在等你回答或批准',leg_blocked:'还有没做完的部分',leg_silent:'没有收到明确的收尾说明',matter_blocked:'工作区暂时不能继续开工',
  next_unavailable:'下一位执行者现在用不了，或状态尚未确认',next_already_tried:'下一棒已经自动派过一次',
}

export function makeRelayDomain(ctx:ServiceCtx,d:{admission:AdmissionDomain;ledger:ReturnType<typeof makeLedgerDomain>}){
  const {store,state}=ctx,processing=new Set<string>()
  function nextExecutor(executor:string,brief:string):RelayInput['nextExecutor']{
    try{d.admission.provider(executor)}catch{return {registered:false,blocked:'unavailable'}}
    // Optional legacy wiring is not evidence that these guards passed.
    if(!ctx.deps.usage||!ctx.deps.refusal||!ctx.deps.executionConflict)return {registered:true,blocked:'unavailable'}
    try{
      if(ctx.deps.refusal(executor))return {registered:true,blocked:'refused'}
      d.admission.requireEntryInput(executor,[],PROVIDER_EXECUTION_CHOICE,brief)
      return {registered:true,blocked:null}
    }catch(error){
      const code=error instanceof Error?error.message:''
      return {registered:true,blocked:code==='provider_quota_exhausted'||code==='provider_rate_limited'?'quota':code==='unattended_ack_required'?'needs_confirmation':'unavailable'}
    }
  }
  function say(id:string,text:string){
    const safe=redactSecrets(text.replace(/[\r\n]+/g,' '))
    store.addEvent(id,'system',safe)
    ctx.deps.reports?.enqueueRelay?.(id,safe)
  }
  function matterState(id:string,running?:Active,ownerInputQueued=false):RelayInput['matter']{
    const task=store.get(id)
    let worktreeRemoved=store.worktrees.get(id)?.removedAt!=null
    try{
      const identity=running?.directoryIdentity??store.entryRequests.forMatter(id)?.directoryIdentity
      worktreeRemoved ||= !identity||canonicalProject(task.path)!==task.path||directoryIdentity(task.path)!==identity
    }catch{worktreeRemoved=true}
    let queued=true
    try{queued=ownerInputQueued||store.liveInputs.count(id)>0}catch{/* Can't read owner input => wait. */}
    return {archived:task.archivedAt!==null,writerNotClosed:task.error==='writer_not_closed'||state.writerOrphans.has(id),worktreeRemoved,rewindBlocked:store.rewinds.blocking(id)!==null,ownerInputQueued:queued}
  }
  function unavailableReason(availability:RelayInput['nextExecutor']){
    if(!availability.registered)return '执行者还没登记'
    return availability.blocked==='quota'?'额度用完了':availability.blocked==='refused'?'执行者的服务拒绝了请求':availability.blocked==='needs_confirmation'?'需要先确认免审执行':REASONS.next_unavailable
  }
  function diagnostic(id:string,reason:RelayStop){
    if(reason!=='plan_inactive'&&reason!=='not_plan_leg')return false
    ctx.log?.('MATTER_RELAY',`${id}: unexpected ${reason}`)
    return true
  }
  function stopCurrent(id:string,current:PlanLeg,reason:RelayStop,running:Active){
    if(diagnostic(id,reason))return
    store.atomic(()=>{store.plans.stop(id,current.position,reason);store.bump(id)})
    running.relayReportedTurn=running.turnSeq
    say(id,reason==='leg_asked'?`第 ${current.position} 棒（${providerDisplayName(current.executor)}）在等你回话，你回了它接着做。`:`停在第 ${current.position} 棒（${providerDisplayName(current.executor)}）：${REASONS[reason]}；说「继续」让它接着做。`)
  }
  function hold(id:string,current:PlanLeg|undefined,next:PlanLeg,reason:RelayStop,availability:RelayInput['nextExecutor'],running?:Active){
    store.atomic(()=>{store.plans.hold(id,current?.position??null,next.position,reason);store.bump(id)})
    if(running)running.relayReportedTurn=running.turnSeq
    const finished=current?`第 ${current.position} 棒（${providerDisplayName(current.executor)}）做完了，`:''
    say(id,`${finished}第 ${next.position} 棒（${providerDisplayName(next.executor)}）没派出去：${reason==='next_unavailable'?unavailableReason(availability):REASONS[reason]}。好了之后说「继续」。`)
  }
  async function dispatch(id:string,current:PlanLeg|undefined,leg:PlanLeg,ownerResume:boolean,running?:Active){
    let accepted=false,availability=nextExecutor(leg.executor,leg.brief)
    processing.add(id)
    try{
      await d.ledger.matterHandoff(id,leg.executor,leg.brief,{from:current?.position??null,to:leg.position,ownerResume,accepted:()=>{accepted=true},beforeStart:()=>{
        availability=nextExecutor(leg.executor,leg.brief)
        if(!availability.registered||availability.blocked!==null)throw Error('unavailable_provider')
        const matter=matterState(id,running)
        if(matter.archived||matter.writerNotClosed||matter.worktreeRemoved||matter.rewindBlocked||matter.ownerInputQueued)throw Error('workbench_busy')
        if(ctx.deps.executionConflict?.(store.get(id).path,leg.executor,null))throw Error('native_session_busy')
      }})
      say(id,`${current?`${providerDisplayName(current.executor)} 做完了，`:''}${providerDisplayName(leg.executor)} 接着做第 ${leg.position} 棒。`)
    }catch(error){
      const plan=store.plans.get(id)
      if(plan?.state!=='approved')return
      const code=error instanceof Error?error.message:''
      const reason:RelayStop=['next_unavailable','unavailable_provider','unattended_ack_required','provider_quota_exhausted','provider_rate_limited'].includes(code)?'next_unavailable':'matter_blocked'
      // An accepted/queued run counts as started, even before provider.spawn is called.
      if(!accepted&&plan.legs.find(l=>l.position===leg.position)?.state==='pending'){
        availability=nextExecutor(leg.executor,leg.brief)
        if(code==='provider_quota_exhausted'||code==='provider_rate_limited')availability={registered:true,blocked:'quota'}
        else if(code==='unattended_ack_required')availability={registered:true,blocked:'needs_confirmation'}
        hold(id,current,leg,reason,availability,running)
      }else if(current&&running)stopCurrent(id,current,reason,running)
      else ctx.log?.('MATTER_RELAY',`${id}: accepted handoff failed: ${code}`)
    }finally{processing.delete(id)}
  }
  const resume:RelayResume=(id,accept)=>{
    const plan=store.plans.get(id)
    if(plan?.state!=='approved'||plan.legs.some(l=>l.state==='running'||l.state==='stopped'))return false
    ctx.ensureAccepting()
    if(processing.has(id))throw Error('workbench_busy')
    const task=store.get(id),owner=ctx.deps.ownerChatId()
    if(!owner||task.ownerChatId!==owner||store.taskMatterId(id)!==id)throw Error('matter_ledger_forbidden')
    const next=plan.legs.find(l=>l.state==='pending'),current=plan.legs.filter(l=>l.position<(next?.position??Infinity)&&l.state==='completed').at(-1)
    const running=state.runsByTask.get(id),availability=next?nextExecutor(next.executor,next.brief):{registered:false,blocked:'unavailable' as const}
    const decision=decideResume({plan,matter:matterState(id,running),nextExecutor:availability})
    accept() // Durable command receipt; never enqueue this command to the completed executor.
    if(decision.action==='dispatch')void trackPreparation(state,dispatch(id,current,next!,true,running)).catch(error=>ctx.log?.('MATTER_RELAY',`${id}: resume failed: ${error instanceof Error?error.message:String(error)}`))
    else if(decision.action==='stop'){
      if(!diagnostic(id,decision.reason)&&next)hold(id,current,next,decision.reason,availability,running)
    }else if(decision.action==='wait')say(id,'你之前的补充还在等处理，接力先等一下。')
    else if(decision.action==='done'){
      store.atomic(()=>{store.plans.done(id);store.bump(id)})
      if(running)running.relayReportedTurn=running.turnSeq
      say(id,`「${task.title}」的 ${plan.legs.length} 棒都做完了。`)
    }
    return true
  }
  const afterTurn:RelayTurnHook=async(running,status,pendingQuestion,ownerInputQueued)=>{
    const id=running.taskId
    if(running.relayClosing||processing.has(id))return
    const plan=store.plans.get(id)
    if(plan?.state!=='approved')return
    const current=plan.legs.find(l=>l.state==='running')
    if(!current)return
    const baton=running.ledgerRunId??running.identity
    if(state.stopping){store.atomic(()=>{store.plans.stop(id,current.position,'leg_interrupted');store.bump(id)});return}
    const task=store.get(id)
    const reply=store.steps(id).filter(s=>timelineKind(s)==='text'&&stepPayload(s).runId===running.identity&&s.turnId===running.turn?.id).at(-1)
    const next=plan.legs.find(l=>l.position>current.position)
    const input:RelayInput={now:ctx.now(),plan,
      finished:{position:current.runId===baton?current.position:null,status:running.cancelled&&!running.relayClosing?'cancelled':['completed','failed','cancelled','interrupted'].includes(status)?status as RelayInput['finished']['status']:'interrupted',uncertain:running.uncertain,pendingQuestion,finalText:reply?stepPayload(reply).text:''},
      matter:matterState(id,running,ownerInputQueued),
      nextExecutor:next?nextExecutor(next.executor,next.brief):{registered:false,blocked:'unavailable'},
    }
    const decision=decideRelay(input)
    if(decision.action==='wait')return
    if(decision.action==='stop'){
      if(diagnostic(id,decision.reason))return
      if(HELD_AFTER_COMPLETION.has(decision.reason)&&next?.state==='pending')hold(id,current,next,decision.reason,input.nextExecutor,running)
      else stopCurrent(id,current,decision.reason,running)
      return
    }
    if(decision.action==='done'){
      store.atomic(()=>{store.plans.done(id,current.position);store.bump(id)})
      running.relayReportedTurn=running.turnSeq
      say(id,`「${task.title}」的 ${plan.legs.length} 棒都做完了。`)
      return
    }
    const leg=plan.legs.find(l=>l.position===decision.position)!
    await dispatch(id,current,leg,false,running)
  }
  return {afterTurn,resume}
}
