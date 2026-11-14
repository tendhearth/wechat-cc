import {afterEach,expect,it,vi} from 'vitest'
import {mkdtempSync,realpathSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {openTestDb} from '../../../lib/db'
import {removeTempDir} from '../../../lib/test-temp'
import {makeWorkbenchStore} from '../../../adapters/store/workbench/store'
import {PROVIDER_EXECUTION_CHOICE} from '../../../adapters/store/workbench/execution-settings'
import {makeRelayDomain} from './relay'
import {directoryIdentity} from './directory-identity'
import {makeRuntimeState,type Active} from './state'
import type {ServiceCtx} from './ctx'
import type {AdmissionDomain} from './admission'
import type {AutoRelayHandoff,makeLedgerDomain} from './ledger'

const cleanups:Array<()=>void>=[]
afterEach(()=>{for(const clean of cleanups.splice(0))clean()})
function fixture(){
  const path=realpathSync(mkdtempSync(join(tmpdir(),'cc-relay-hook-'))),db=openTestDb(),store=makeWorkbenchStore(db),state=makeRuntimeState()
  cleanups.push(()=>{db.close();removeTempDir(path)})
  const task=store.create({title:'接力',path,providerId:'codex',ownerChatId:'owner'}),id=task.id
  store.ledger.start(id,'first','codex','先做');store.plans.approve(id,[{executor:'codex',brief:'先做'},{executor:'claude',brief:'接着做'}],'first')
  const turn=store.execution.accept(id,'dispatch',PROVIDER_EXECUTION_CHOICE)
  store.addEvent(id,'text','已完成。',null,'dispatch',[],turn!)
  const running={taskId:id,identity:'dispatch',ledgerRunId:'first',directoryIdentity:directoryIdentity(path),turn:{id:turn!,open:false},turnSeq:1,cancelled:false,uncertain:false} as Active
  const notices:string[]=[],logs:string[]=[],handoff=vi.fn(async(_id:string,_executor:string,_brief:string,_automatic?:AutoRelayHandoff)=>({}))
  const ctx={store,state,now:()=>Date.now(),ensureAccepting:()=>{},log:(_tag:string,text:string)=>logs.push(text),deps:{ownerChatId:()=>'owner',usage:()=>null,refusal:()=>null,executionConflict:()=>false,reports:{enqueueRelay:(_id:string,text:string)=>notices.push(text)}}} as unknown as ServiceCtx
  const relay=makeRelayDomain(ctx,{admission:{provider:()=>({}),requireEntryInput:()=>{}} as unknown as AdmissionDomain,ledger:{matterHandoff:handoff} as unknown as ReturnType<typeof makeLedgerDomain>})
  return {id,db,store,running,notices,logs,handoff,relay}
}

it('a handoff exception after acceptance never holds an already accepted next runtime as pending',async()=>{
  const f=fixture()
  f.handoff.mockImplementation(async(_id,_executor,_brief,automatic)=>{
    f.store.plans.advance(f.id,1,2,'accepted-next')
    automatic!.accepted!()
    throw Error('native_session_busy')
  })
  await f.relay.afterTurn(f.running,'completed',false)
  expect(f.store.plans.get(f.id)?.legs).toMatchObject([{state:'completed',stopReason:null},{state:'running',runId:'accepted-next',autoDispatches:1,stopReason:null}])
  expect(f.notices.some(text=>text.includes('没派出去'))).toBe(false)
})

it.each(['plan_inactive','not_plan_leg'] as const)('%s is logged without an owner notification or stopping the plan baton',async reason=>{
  const f=fixture()
  if(reason==='not_plan_leg')f.running.ledgerRunId='another-baton'
  else{
    const plan=f.store.plans.get(f.id)!
    vi.spyOn(f.store.plans,'get').mockReturnValue({...plan,approvedAt:null as unknown as number})
  }
  await f.relay.afterTurn(f.running,'completed',false)
  expect(f.logs).toEqual([`${f.id}: unexpected ${reason}`]);expect(f.notices).toEqual([])
  expect(f.handoff).not.toHaveBeenCalled()
  expect(f.store.plans.get(f.id)?.legs[0]?.state).toBe('running')
})

it('resume of an already completed plan marks it done without starting any runtime',()=>{
  const f=fixture(),accepted=vi.fn()
  f.store.plans.advance(f.id,1,2,'second')
  f.store.plans.done(f.id,2)
  // A crash/older writer can leave all legs complete but the plan header still approved.
  f.db.query("UPDATE matter_plans SET state='approved' WHERE matter_id=?").run(f.id)
  expect(f.relay.resume(f.id,accepted)).toBe(true)
  expect(accepted).toHaveBeenCalledOnce();expect(f.store.plans.get(f.id)?.state).toBe('done')
  expect(f.handoff).not.toHaveBeenCalled();expect(f.notices).toEqual(['「接力」的 2 棒都做完了。'])
})
