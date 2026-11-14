import {decideRelay,type RelayInput,type RelayStop} from '../../../domain/relay-decision'
import {PROVIDER_EXECUTION_CHOICE} from '../../../adapters/store/workbench/execution-settings'
import {stepPayload,timelineKind} from '../../../adapters/store/workbench/store'
import {canonicalProject} from '../../../adapters/workbench/artifacts'
import {providerDisplayName} from '../../../domain/provider-display-names'
import {redactSecrets} from '../../../domain/cli-transcript'
import {directoryIdentity} from './directory-identity'
import type {ServiceCtx} from './ctx'
import type {AdmissionDomain} from './admission'
import type {makeLedgerDomain} from './ledger'
import type {RelayTurnHook} from './relay-events'

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
    let worktreeRemoved=store.worktrees.get(id)?.removedAt!=null
    try{worktreeRemoved ||= canonicalProject(task.path)!==task.path||directoryIdentity(task.path)!==running.directoryIdentity}catch{worktreeRemoved=true}
    let queued=true
    try{queued=!!ownerInputQueued||store.liveInputs.count(id)>0}catch{/* Can't read owner input => wait. */}
    const reply=store.steps(id).filter(s=>timelineKind(s)==='text'&&stepPayload(s).runId===running.identity&&s.turnId===running.turn?.id).at(-1)
    const next=plan.legs.find(l=>l.position>current.position)
    const input:RelayInput={now:ctx.now(),plan,
      finished:{position:current.runId===baton?current.position:null,status:running.cancelled&&!running.relayClosing?'cancelled':['completed','failed','cancelled','interrupted'].includes(status)?status as RelayInput['finished']['status']:'interrupted',uncertain:running.uncertain,pendingQuestion,finalText:reply?stepPayload(reply).text:''},
      matter:{archived:task.archivedAt!==null,writerNotClosed:task.error==='writer_not_closed'||state.writerOrphans.has(id),worktreeRemoved,rewindBlocked:store.rewinds.blocking(id)!==null,ownerInputQueued:queued},
      nextExecutor:next?nextExecutor(next.executor,next.brief):{registered:false,blocked:'unavailable'},
    }
    const decision=decideRelay(input)
    if(decision.action==='wait')return
    const stop=(reason:RelayStop)=>{
      store.atomic(()=>{store.plans.stop(id,current.position,reason);store.bump(id)})
      running.relayReportedTurn=running.turnSeq
      say(id,`停在第 ${current.position} 棒（${providerDisplayName(current.executor)}）：${REASONS[reason]}；说「继续」可续这一棒。`)
    }
    if(decision.action==='stop'){stop(decision.reason);return}
    if(decision.action==='done'){
      store.atomic(()=>{store.plans.done(id,current.position);store.bump(id)})
      running.relayReportedTurn=running.turnSeq
      say(id,`「${task.title}」的 ${plan.legs.length} 棒都做完了。`)
      return
    }
    const leg=plan.legs.find(l=>l.position===decision.position)!
    processing.add(id)
    try{
      await d.ledger.matterHandoff(id,leg.executor,leg.brief,{from:current.position,to:leg.position,beforeStart:()=>{
        if(nextExecutor(leg.executor,leg.brief).blocked!==null)throw Error('unavailable_provider')
        if(ctx.deps.executionConflict?.(task.path,leg.executor,null))throw Error('native_session_busy')
      }})
      say(id,`${providerDisplayName(current.executor)} 做完了，${providerDisplayName(leg.executor)} 接着做第 ${leg.position} 棒。`)
    }catch(error){
      if(store.plans.get(id)?.state==='approved')stop(error instanceof Error&&['next_unavailable','unavailable_provider','unattended_ack_required','provider_quota_exhausted'].includes(error.message)?'next_unavailable':'matter_blocked')
    }finally{processing.delete(id)}
  }
  return {afterTurn}
}
