import {afterEach,beforeEach,expect,it} from 'vitest'
import {mkdtempSync,mkdirSync,realpathSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {openDb,type Db} from '../../lib/db'
import {createProviderRegistry} from '../provider-registry'
import type {AgentExecutionChoice,AgentProvider,SpawnContext} from '../agent-provider'
import {makeWorkbenchStore} from './store'
import {makeWorkbenchService,type WorkbenchService} from './service'
import {PROVIDER_EXECUTION_CHOICE as automatic} from './execution-settings'
import {MANAGED_NATIVE_CAPABILITIES} from './executor-capabilities'

let root:string,project:string,db:Db,service:WorkbenchService,store:ReturnType<typeof makeWorkbenchStore>
const selected:AgentExecutionChoice={defaults:'provider',model:'fixture-model',reasoningEffort:'high'}
function setup(provider:AgentProvider,resume=true){
  const registry=createProviderRegistry()
  for(const id of ['claude','codex'])registry.register(id,provider,{displayName:id,canResume:()=>resume,workbench:MANAGED_NATIVE_CAPABILITIES})
  store=makeWorkbenchStore(db);service=makeWorkbenchService({store,registry,stateDir:root,ownerChatId:()=>null})
}
function gate(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return{promise,resolve}}
async function settled(id:string){await expect.poll(()=>service.detail(id).task.status).not.toMatch(/^(queued|running|cancelling)$/)}
function executor(onSpawn?:(context:SpawnContext,index:number)=>void,wait?:Promise<void>):AgentProvider{
  let index=0
  return {async spawn(_project,context){const i=index++;onSpawn?.(context,i);return{async *dispatch(){yield {kind:'init',sessionId:context.resumeSessionId??`native-${i}`};if(wait&&i===0)await wait;yield {kind:'text',text:'review detail'};yield {kind:'result',sessionId:context.resumeSessionId??`native-${i}`,numTurns:1,durationMs:1}},async close(){}}}}
}
beforeEach(()=>{root=realpathSync(mkdtempSync(join(tmpdir(),'cc-execution-service-')));project=join(root,'project');mkdirSync(project);db=openDb({path:join(root,'state.db')})})
afterEach(async()=>{await service?.shutdown();db.close();rmSync(root,{recursive:true,force:true})})

it('dispatches the accepted task choice and keeps actual native evidence separate',async()=>{
  const contexts:SpawnContext[]=[]
  setup(executor(ctx=>{contexts.push(ctx);ctx.reportExecution?.({model:'native-fallback',source:'native_reroute'})}))
  const task=service.create({path:project,providerId:'codex',text:'first',execution:selected});await settled(task.id)
  expect(contexts[0]?.execution).toEqual(selected)
  expect(service.detail(task.id)).toMatchObject({execution:selected,lastExecution:{choice:selected,effective:{model:'native-fallback',source:'native_reroute'}}})
  contexts[0]!.reportExecution?.({model:'too-late',source:'native_message'})
  expect(service.detail(task.id).lastExecution?.effective?.model).toBe('native-fallback')
})

it('freezes queued choices despite caller mutation and isolates another project',async()=>{
  const pending=gate(),contexts:SpawnContext[]=[]
  setup(executor(ctx=>{contexts.push(ctx)},pending.promise))
  const first=service.create({path:project,providerId:'claude',text:'first'});await expect.poll(()=>contexts.length).toBe(1)
  const choice={...selected},second=service.create({path:project,providerId:'codex',text:'second',execution:choice})
  choice.model='mutated';choice.reasoningEffort='low'
  const other=join(root,'other');mkdirSync(other)
  const third=service.create({path:other,providerId:'claude',text:'parallel',execution:{...selected,model:'another'}});await settled(third.id)
  expect(service.detail(second.id).task.status).toBe('queued')
  pending.resolve();await settled(first.id);await settled(second.id)
  expect(contexts.map(c=>c.execution)).toEqual([automatic,{...selected,model:'another'},selected])
  expect(service.detail(second.id).lastExecution?.effective).toBeNull()
})

it('retains the chosen model on continuation and binds terminal receipt retries to it',async()=>{
  const seen:SpawnContext[]=[];setup(executor(ctx=>{seen.push(ctx)}))
  const task=service.create({path:project,providerId:'codex',text:'start',execution:selected});await settled(task.id)
  const inputRequestId=randomUUID()
  service.continueTask(task.id,'next',{inputRequestId});await settled(task.id)
  expect(seen[1]?.execution).toEqual(selected)
  expect(service.detail(task.id).inputs[0]?.execution).toEqual(selected)
  expect(()=>service.continueTask(task.id,'next',{inputRequestId,execution:{...selected,model:'changed'}})).toThrow('input_conflict')
  service.continueTask(task.id,'new choice',{execution:{...automatic}});await settled(task.id)
  service.continueTask(task.id,'next',{inputRequestId})
  expect(seen).toHaveLength(3)
  expect(service.detail(task.id).execution).toEqual(automatic)
})

it('queued supplements inherit their accepted run rather than later mutable task defaults',async()=>{
  const pending=gate(),seen:SpawnContext[]=[];setup(executor(ctx=>{seen.push(ctx)},pending.promise))
  const task=service.create({path:project,providerId:'claude',text:'start',execution:selected});await expect.poll(()=>seen.length).toBe(1)
  const runId=service.detail(task.id).runId!,requestId=randomUUID()
  const receipt=await service.submitInput(task.id,{runId,requestId,text:'next'})
  expect(receipt.execution).toEqual(selected)
  store.execution.accept(task.id,randomUUID(),{...automatic,model:'later'})
  pending.resolve();await expect.poll(()=>seen.length).toBe(2);await settled(task.id)
  expect(seen[1]?.execution).toEqual(selected)
  expect(store.liveInputs.get(requestId)).toMatchObject({runId,execution:selected,status:'delivered'})
})

it('does not permit live input to override an active run model',async()=>{
  const pending=gate();setup(executor(undefined,pending.promise))
  const task=service.create({path:project,providerId:'codex',text:'start',execution:selected})
  await expect.poll(()=>service.detail(task.id).task.status).toBe('running')
  await expect(service.submitInput(task.id,{runId:service.detail(task.id).runId!,requestId:randomUUID(),text:'change',execution:automatic})).rejects.toThrow('invalid_execution')
  expect(service.detail(task.id).inputs).toEqual([]);pending.resolve();await settled(task.id)
})

it('creates a review with target defaults and returns revision to the original model',async()=>{
  const seen:SpawnContext[]=[];setup(executor(ctx=>{seen.push(ctx)}))
  const task=service.create({path:project,providerId:'codex',text:'make',execution:selected});await settled(task.id)
  const preview=await service.previewHandoff({sourceTaskId:task.id,targetProviderId:'claude',purpose:'review',request:'review',artifacts:[]})
  expect(preview.targetExecution).toEqual(automatic)
  const review=await service.handoff({token:preview.token});await settled(review.task.id)
  const event=store.events(review.task.id).find(e=>e.kind==='text')!
  const back=await service.previewHandoff({sourceTaskId:review.task.id,targetTaskId:task.id,targetProviderId:'codex',purpose:'revision',request:'apply',artifacts:[],quote:{taskId:review.task.id,eventId:event.id,text:event.text}})
  expect(back.targetExecution).toEqual(selected)
  await service.handoff({token:back.token});await settled(task.id)
  expect(seen.map(c=>c.execution)).toEqual([selected,automatic,selected])
  expect(service.handoffRecord(review.task.id,review.handoffId).packet.execution).toEqual(automatic)
})

it('invalidates handoff decisions when the target choice changes without a task timestamp change',async()=>{
  setup(executor());const task=service.create({path:project,providerId:'codex',text:'make',execution:selected});await settled(task.id)
  const preview=await service.previewHandoff({sourceTaskId:task.id,targetProviderId:'claude',purpose:'review',request:'review',artifacts:[]})
  store.execution.accept(task.id,randomUUID(),automatic)
  await expect(service.handoff({token:preview.token})).rejects.toThrow('handoff_changed')
})

it('invalidates a restart preview when retained execution changes',async()=>{
  setup(executor(),false);const task=service.create({path:project,providerId:'codex',text:'make',execution:selected});await settled(task.id)
  const preview=service.detail(task.id).continuation!.restart!
  store.execution.accept(task.id,randomUUID(),automatic)
  expect(()=>service.continueTask(task.id,'again',{restartToken:preview.token})).toThrow('restart_confirmation_stale')
})

it('requires a new restart preview for the selected next model without applying it before acceptance',async()=>{
  const seen:SpawnContext[]=[];setup(executor(ctx=>{seen.push(ctx)}),false)
  const task=service.create({path:project,providerId:'codex',text:'make',execution:selected});await settled(task.id)
  const old=service.detail(task.id).continuation!.restart!,next={...selected,model:'next-model'}
  expect(()=>service.continueTask(task.id,'again',{restartToken:old.token,execution:next})).toThrow('restart_confirmation_stale')
  const prepared=service.prepareContinuation(task.id,next).restart!
  expect(prepared.token).not.toBe(old.token)
  expect(service.detail(task.id).execution).toEqual(selected)
  expect(seen).toHaveLength(1)
  service.continueTask(task.id,'again',{restartToken:prepared.token,execution:next});await settled(task.id)
  expect(seen[1]?.execution).toEqual(next)
})

it('queries the provider catalog with canonical project scope without spawning a task',async()=>{
  const projects:string[]=[],catalog={source:'native' as const,models:[{id:'model',displayName:'Model',reasoningEfforts:['low','high']}]}
  setup({...executor(()=>{throw Error('discovery must not spawn')}),async modelCatalog(p){projects.push(p.path);return catalog}})
  expect(await service.modelCatalog('codex',project+'/')).toEqual(catalog)
  expect(projects).toEqual([project]);expect(service.list().tasks).toEqual([])
  await expect(service.modelCatalog('codex',join(root,'absent'))).rejects.toThrow('invalid_path')
})

it('rejects malformed execution before creating a task or accepting a user event',()=>{
  setup(executor())
  expect(()=>service.create({path:project,providerId:'codex',text:'make',execution:{...selected,reasoningEffort:'bad value'}})).toThrow('invalid_execution')
  expect(service.list().tasks).toEqual([])
})

it('preserves catalog-invalid errors through the real service boundary and hides unknown diagnostics',async()=>{
  setup({...executor(),async modelCatalog(){throw Error('model_catalog_invalid')}})
  await expect(service.modelCatalog('claude',project)).rejects.toThrow('model_catalog_invalid')
  await service.shutdown()
  setup({...executor(),async modelCatalog(){throw Error('private native diagnostic')}})
  await expect(service.modelCatalog('claude',project)).rejects.toThrow('model_catalog_unavailable')
})

it('keeps model failure codes diagnostic while explaining the next action in the task conversation',async()=>{
  setup({async spawn(){throw Error('execution_model_unsupported')}})
  const task=service.create({path:project,providerId:'codex',text:'work',execution:selected});await settled(task.id)
  const detail=service.detail(task.id)
  expect(detail.task.error).toBe('execution_model_unsupported')
  expect(detail.events.filter(e=>e.kind==='error').at(-1)?.text).toBe('当前模型不可用，请重新选择模型，或使用自动。')
  expect(detail.execution).toEqual(selected);expect(detail.lastExecution?.effective).toBeNull()
})
