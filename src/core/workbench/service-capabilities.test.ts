import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {mkdtempSync,mkdirSync,realpathSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID} from 'node:crypto'
import {openDb,type Db} from '../../lib/db'
import {createProviderRegistry,type ProviderRegistration} from '../provider-registry'
import type {AgentEvent,AgentProvider} from '../agent-provider'
import {MANAGED_NATIVE_CAPABILITIES} from './executor-capabilities'
import {makeWorkbenchStore} from './store'
import {makeWorkbenchService,type WorkbenchService} from './service'

let root:string,project:string,db:Db,service:WorkbenchService,store:ReturnType<typeof makeWorkbenchStore>
const result:AgentEvent={kind:'result',sessionId:'native',numTurns:1,durationMs:1}
const registration=(changes:Partial<ProviderRegistration>={}):ProviderRegistration=>({displayName:'Managed',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES,...changes})
const provider=(spawn=vi.fn(async()=>({async *dispatch(){yield result},async close(){}}))):AgentProvider=>({spawn})
function setup(entries:Array<{id:string;provider:AgentProvider;opts:ProviderRegistration}>){
  const registry=createProviderRegistry()
  for(const entry of entries)registry.register(entry.id,entry.provider,entry.opts)
  store=makeWorkbenchStore(db);service=makeWorkbenchService({store,registry,stateDir:root,ownerChatId:()=>null})
  return registry
}
function gate(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return{promise,resolve}}
async function settle(id:string){await expect.poll(()=>service.detail(id).task.status).not.toMatch(/^(queued|running|cancelling)$/)}

beforeEach(()=>{root=realpathSync(mkdtempSync(join(tmpdir(),'cc-service-cap-')));project=join(root,'project');mkdirSync(project);db=openDb({path:join(root,'state.db')})})
afterEach(async()=>{await service?.shutdown();db.close();rmSync(root,{recursive:true,force:true})})

describe('workbench executor admission',()=>{
  it('does not admit a provider by brand and returns copied capabilities for an admitted arbitrary provider',async()=>{
    const ordinary=provider(),managed=provider()
    setup([{id:'claude',provider:ordinary,opts:{displayName:'Claude chat',canResume:()=>true}},{id:'fixture',provider:managed,opts:registration()}])
    expect(()=>service.create({path:project,providerId:'claude',text:'must not persist'})).toThrow('unavailable_provider')
    expect(store.list()).toHaveLength(0)
    const listed=service.list().providers
    expect(listed.map(p=>p.id)).toEqual(['fixture']);expect(listed[0]?.capabilities).toEqual(MANAGED_NATIVE_CAPABILITIES)
    ;(listed[0]!.capabilities.features as {attachments:boolean}).attachments=false
    expect(service.list().providers[0]?.capabilities.features.attachments).toBe(true)
    const task=service.create({path:project,providerId:'fixture',text:'run'});await settle(task.id)
    expect(managed.spawn).toHaveBeenCalledOnce();expect(ordinary.spawn).not.toHaveBeenCalled()
  })

  it('rejects unsupported attachments and execution before creating or binding a task',()=>{
    const capabilities={...MANAGED_NATIVE_CAPABILITIES,features:{...MANAGED_NATIVE_CAPABILITIES.features,attachments:false,executionSettings:false}}
    setup([{id:'limited',provider:provider(),opts:registration({workbench:capabilities})}])
    const draftId=randomUUID(),attachment=service.uploadAttachment({id:randomUUID(),draftId,name:'brief.txt',mime:'text/plain',base64:Buffer.from('brief').toString('base64')})
    expect(()=>service.create({path:project,providerId:'limited',text:'read',draftId,attachmentIds:[attachment.id]})).toThrow('workbench_attachments_unsupported')
    expect(()=>service.create({path:project,providerId:'limited',text:'run',execution:{model:'chosen'}})).toThrow('workbench_execution_unsupported')
    expect(store.list()).toHaveLength(0);expect(store.attachments.select([attachment.id],undefined,draftId)).toEqual([attachment])
  })

  it('rechecks mutated capabilities while queued and never spawns the rejected task',async()=>{
    const first=gate(),spawn=vi.fn(async()=>({async *dispatch(){await first.promise;yield result},async close(){first.resolve()}})),opts=registration()
    setup([{id:'managed',provider:provider(spawn),opts}])
    const active=service.create({path:project,providerId:'managed',text:'first'});await expect.poll(()=>spawn).toHaveBeenCalledOnce()
    const queued=service.create({path:project,providerId:'managed',text:'second'});expect(service.detail(queued.id).task.status).toBe('queued')
    opts.workbench=undefined;first.resolve();await settle(active.id);await settle(queued.id)
    expect(spawn).toHaveBeenCalledTimes(1);expect(service.detail(queued.id).task.status).toBe('failed')
  })

  it('rejects live material after capability mutation without binding or creating a receipt',async()=>{
    const pending=gate(),opts=registration(),spawn=vi.fn(async()=>({async *dispatch(){await pending.promise;yield result},async close(){pending.resolve()}}))
    setup([{id:'managed',provider:provider(spawn),opts}]);const task=service.create({path:project,providerId:'managed',text:'first'})
    await expect.poll(()=>service.detail(task.id).task.status).toBe('running')
    const draftId=randomUUID(),attachment=service.uploadAttachment({id:randomUUID(),draftId,name:'later.txt',mime:'text/plain',base64:Buffer.from('later').toString('base64')})
    opts.workbench={...MANAGED_NATIVE_CAPABILITIES,features:{...MANAGED_NATIVE_CAPABILITIES.features,attachments:false}}
    await expect(service.submitInput(task.id,{runId:service.detail(task.id).runId!,requestId:randomUUID(),text:'read',draftId,attachmentIds:[attachment.id]})).rejects.toThrow('workbench_attachments_unsupported')
    expect(store.liveInputs.list(task.id)).toEqual([]);expect(store.attachments.select([attachment.id],undefined,draftId)).toEqual([attachment]);pending.resolve()
  })

  it('does not call native resume checking when the feature is absent and preserves explicit restart',async()=>{
    const canResume=vi.fn(()=>true),spawn=vi.fn(async()=>({async *dispatch(){yield result},async close(){}}))
    const capabilities={...MANAGED_NATIVE_CAPABILITIES,features:{...MANAGED_NATIVE_CAPABILITIES.features,nativeResume:false}}
    setup([{id:'limited',provider:provider(spawn),opts:registration({canResume,workbench:capabilities})}])
    const task=service.create({path:project,providerId:'limited',text:'first'});await settle(task.id)
    const decision=service.prepareContinuation(task.id);expect(decision.mode).toBe('restart_required');expect(canResume).not.toHaveBeenCalled()
    if(decision.mode!=='restart_required')throw Error('expected restart')
    service.continueTask(task.id,'again',{restartToken:decision.restart.token});await settle(task.id)
    expect(spawn).toHaveBeenCalledTimes(2);expect(canResume).not.toHaveBeenCalled()
  })

  it('gates model discovery on the declared feature',async()=>{
    const modelCatalog=vi.fn(async()=>({models:[],reasoningEfforts:[],source:'native' as const})),capabilities={...MANAGED_NATIVE_CAPABILITIES,features:{...MANAGED_NATIVE_CAPABILITIES.features,modelCatalog:false}}
    setup([{id:'limited',provider:{...provider(),modelCatalog},opts:registration({workbench:capabilities})}])
    await expect(service.modelCatalog('limited',project)).rejects.toThrow('model_catalog_unavailable');expect(modelCatalog).not.toHaveBeenCalled()
  })

  it('can hand a fixed task context to an admitted provider beyond the two native history readers',async()=>{
    const reviewer=provider()
    setup([{id:'claude',provider:provider(),opts:registration()},{id:'reviewer-v2',provider:reviewer,opts:registration()}])
    const source=service.create({path:project,providerId:'claude',text:'original'});await settle(source.id)
    const preview=await service.previewHandoff({sourceTaskId:source.id,targetProviderId:'reviewer-v2',purpose:'review',request:'check original',artifacts:[]})
    const accepted=await service.handoff({token:preview.token});await settle(accepted.task.id)
    expect(accepted.task.providerId).toBe('reviewer-v2');expect(reviewer.spawn).toHaveBeenCalledOnce()
    expect(service.detail(accepted.task.id).handoffs[0]?.sourceTaskId).toBe(source.id)
  })

  it('rejects inherited restart material before recording a revision or consuming its decision',async()=>{
    const originalOptions=registration({canResume:()=>false})
    const reviewProvider:AgentProvider={async spawn(){return{async *dispatch(){yield{kind:'text',text:'selected advice'};yield{...result,sessionId:'review-native'}},async close(){}}}}
    setup([{id:'claude',provider:provider(),opts:originalOptions},{id:'codex',provider:reviewProvider,opts:registration()}])
    const draftId=randomUUID(),attachment=service.uploadAttachment({id:randomUUID(),draftId,name:'original.txt',mime:'text/plain',base64:Buffer.from('retained context').toString('base64')})
    const original=service.create({path:project,providerId:'claude',text:'original',draftId,attachmentIds:[attachment.id]});await settle(original.id)
    const review=await service.handoff({token:(await service.previewHandoff({sourceTaskId:original.id,targetProviderId:'codex',purpose:'review',request:'review',artifacts:[]})).token});await settle(review.task.id)
    const event=store.events(review.task.id).find(e=>e.kind==='text')!
    const input={sourceTaskId:review.task.id,targetTaskId:original.id,targetProviderId:'claude',purpose:'revision' as const,request:'apply selected advice',artifacts:[],quote:{taskId:review.task.id,eventId:event.id,text:event.text}}
    const preview=await service.previewHandoff(input)
    if(preview.targetContinuation?.mode!=='restart_required')throw Error('expected restart')
    expect(preview.targetContinuation.restart.attachments).toHaveLength(1)
    const before={events:store.events(original.id),handoffs:store.handoffs(original.id),task:store.get(original.id)}
    originalOptions.workbench={...MANAGED_NATIVE_CAPABILITIES,features:{...MANAGED_NATIVE_CAPABILITIES.features,attachments:false}}
    const args={token:preview.token,restartToken:preview.targetContinuation.restart.token}
    await expect(service.handoff(args)).rejects.toThrow('workbench_attachments_unsupported')
    expect({events:store.events(original.id),handoffs:store.handoffs(original.id),task:store.get(original.id)}).toEqual(before)
    await expect(service.previewHandoff(input)).rejects.toThrow('workbench_attachments_unsupported')
    originalOptions.workbench=MANAGED_NATIVE_CAPABILITIES
    const accepted=await service.handoff(args);await settle(accepted.task.id)
    expect(store.handoffs(original.id)).toHaveLength(before.handoffs.length+1)
    expect(store.events(original.id).filter(e=>e.kind==='user')).toHaveLength(2)
  })
})
