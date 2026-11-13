import type {MatterNotesQuery} from '../../../ports/matters'
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

export function makeLedgerDomain(ctx:ServiceCtx,d:{execute:ExecuteDomain;lifecycle:LifecycleDomain;admission:AdmissionDomain}){
  const {store,state}=ctx,inFlight=new Set<string>()
  return {
    matterNotes:(key:string|undefined,requested?:string,q?:MatterNotesQuery)=>store.ledger.page(store.ledger.bound(key,requested),q),
    matterNote(key:string|undefined,text:string){
      const id=store.ledger.bound(key),run=state.runsByTask.get(id)
      if(!store.ledger.enabled(id)||!run||run.cancelled||run.finishing||run.uncertain)throw Error('matter_session_ended')
      if(typeof text!=='string'||!text.trim()||text.length>1000)throw Error('invalid_matter_note')
      store.atomic(()=>{store.ledger.note(id,run.ledgerRunId??run.identity,run.task.providerId,text,run.turn?.id);store.bump(id)})
      return {ok:true as const}
    },
    ledgerOwned:(id:string,owner:string|null)=>!!owner&&store.get(id).ownerChatId===owner,
    ledgerRead:(id:string)=>(store.ledger.enabled(id)?{agentRuns:store.ledger.agents(id),...store.ledger.recent(id)}:{}),
    async matterHandoff(id:string,executor:string,brief:string){
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
          if(store.liveInputs.next(id))throw Error('workbench_busy')
          assertNotRewindBlocked(store.rewinds,id)
          if(canonicalProject(task.path)!==task.path)throw Error('invalid_path')
          d.admission.requireEntryInput(executor,[],PROVIDER_EXECUTION_CHOICE,text)
          return task
        }
        let task=check()
        const prior=state.runsByTask.get(id)
        if(prior){
          if(!d.lifecycle.quiet(prior)||prior.cancelled||prior.finishing||prior.uncertain)throw Error('workbench_busy')
          await d.lifecycle.cancel(id,prior.identity)
          await prior.done
        }
        ctx.ensureAccepting()
        task=check()
        if(state.runsByTask.has(id)||state.writerOrphans.has(id))throw Error('workbench_busy')
        const identity=directoryIdentity(task.path)
        if(prior&&identity!==prior.directoryIdentity)throw Error('invalid_path')
        let activate:(()=>void)|undefined
        const view=store.atomic(()=>{
          if(!store.ledger.enabled(id))seedLedger(ctx,task,prior)
          store.switchExecutor(id,executor)
          return d.execute.start(store.get(id),text,identity,{mode:'new'},undefined,undefined,undefined,undefined,[],undefined,PROVIDER_EXECUTION_CHOICE,{ledgerOpening:true,persist:()=>{},activate:fn=>{activate=fn}})
        })
        activate?.()
        return {...view,...publicTask(store.get(id))}
      }finally{inFlight.delete(id)}
    },
  }
}
