import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {randomUUID} from 'node:crypto'
import {mkdtempSync,mkdirSync,readFileSync,realpathSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {openDb,type Db} from '../../lib/db'
import {removeTempDir} from '../../lib/test-temp'
import {createProviderRegistry} from '../provider-registry'
import type {AgentAttachment,AgentEvent,AgentProvider} from '../agent-provider'
import {MANAGED_NATIVE_CAPABILITIES} from '../workbench/executor-capabilities'
import {makeWorkbenchStore} from '../workbench/store'
import {makeWorkbenchService,type WorkbenchService} from '../workbench/service'
import {makeMatterStore,type MatterStore} from './store'
import {makeMattersService,type MattersService,type MattersServiceDeps} from './service'

let root:string,project:string,db:Db,store:ReturnType<typeof makeWorkbenchStore>,matterStore:MatterStore,workbench:WorkbenchService,service:MattersService
let active:WorkbenchService[]=[]
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jY9kAAAAASUVORK5CYII=','base64')
const result:AgentEvent={kind:'result',sessionId:'native-session',numTurns:1,durationMs:1}
function gate(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return{promise,resolve}}
function setup(provider:AgentProvider,resume=true){
  const registry=createProviderRegistry()
  registry.register('claude',provider,{displayName:'Claude',canResume:()=>resume,workbench:MANAGED_NATIVE_CAPABILITIES})
  workbench=makeWorkbenchService({store,registry,stateDir:root,ownerChatId:()=>'owner',matters:matterStore})
  active.push(workbench)
  service=makeMattersService({store:matterStore,workbench})
}
function upload(taskId?:string,ownerKey:string|null='owner',draftId=randomUUID(),name='参考.png'){
  const attachment=store.attachments.upload({id:randomUUID(),draftId,taskId,name,mime:'image/png',base64:png.toString('base64')},root,ownerKey?{ownerKey}:undefined)
  return{draftId,attachmentIds:[attachment.id],attachment}
}
async function settled(id:string){await expect.poll(()=>workbench.detail(id).task.status).not.toMatch(/^(queued|running|cancelling)$/)}
beforeEach(()=>{
  active=[]
  root=realpathSync(mkdtempSync(join(tmpdir(),'cc-matter-materials-')));project=join(root,'project');mkdirSync(project)
  db=openDb({path:join(root,'state.db')});store=makeWorkbenchStore(db);matterStore=makeMatterStore(db)
})
afterEach(async()=>{for(const running of active)await running.shutdown();db.close();removeTempDir(root)})

describe('matter materials',()=>{
  it('projects only public material fields for recent events and held input receipts',async()=>{
    const task={id:'deadbeef',title:'t',status:'running',providerId:'claude',path:project,error:null,updatedAt:1}
    matterStore.create({id:task.id,kind:'task',title:'t'})
    const safe={id:randomUUID(),name:'图.png',mime:'image/png',size:png.length,sha256:'a'.repeat(64)}
    const internal={...safe,ownerKey:'private owner',storagePath:'/secret/blob',draftId:randomUUID(),base64:'private bytes'}
    const input={id:randomUUID(),taskId:task.id,runId:'original-run',text:'',status:'held' as const,createdAt:1,error:'internal',attachments:[internal]}
    const events=Array.from({length:55},(_,createdAt)=>({kind:'user',text:'',createdAt,attachments:[internal]}))
    service=makeMattersService({store:matterStore,workbench:{detail:()=>({task,events,inputs:[input,{...input,taskId:'00000001'}]}),continueTask:()=>task}})
    const detail=await service.detail(task.id)
    expect(detail.events).toHaveLength(50)
    expect(detail.events[0]).toEqual({kind:'user',text:'',createdAt:5,attachments:[safe]})
    expect(detail.inputs).toEqual([{id:input.id,taskId:task.id,runId:'original-run',text:'',status:'held',attachments:[safe]}])
    expect(JSON.stringify(detail)).not.toMatch(/private owner|secret\/blob|private bytes|draftId/)
  })

  it('shows an image-only first turn in the same matter without base64 or storage paths',async()=>{
    const received:AgentAttachment[][]=[]
    setup({async spawn(){return{async *dispatch(_text,files){received.push([...(files??[])]);yield result},async close(){}}}})
    const material=upload(),task=workbench.create({path:project,providerId:'claude',text:'',...material})
    await settled(task.id)
    const detail=await service.detail(task.id)
    expect(detail.matter.id).toBe(task.id)
    expect(detail.events.find(e=>e.kind==='user')).toMatchObject({text:'',attachments:[material.attachment]})
    expect(readFileSync(received[0]![0]!.path)).toEqual(png)
    expect(JSON.stringify(detail.events)).not.toContain(png.toString('base64'))
  })

  it('delivers an image-only live supplement and replays the original request/run after the later run finishes',async()=>{
    const first=gate(),received:AgentAttachment[][]=[]
    setup({async spawn(){return{async *dispatch(_text,files){received.push([...(files??[])]);if(received.length===1)await first.promise;yield result},async close(){first.resolve()}}}})
    const task=workbench.create({path:project,providerId:'claude',text:'start'});await expect.poll(()=>received.length).toBe(1)
    const material=upload(task.id),request={...material,requestId:randomUUID(),runId:workbench.detail(task.id).runId!}
    const queued=await service.say(task.id,'','phone',request)
    expect(queued).toMatchObject({kind:'task',task:{id:task.id},input:{id:request.requestId,runId:request.runId,status:'pending',attachments:[material.attachment]}})
    first.resolve();await expect.poll(()=>received.length).toBe(2);await settled(task.id)
    const replay=await service.say(task.id,'','phone',request)
    expect(replay).toMatchObject({input:{id:request.requestId,runId:request.runId,status:'delivered',attachments:[material.attachment]}})
    expect(readFileSync(received[1]![0]!.path)).toEqual(png)
    expect(store.events(task.id).filter(e=>e.kind==='user').at(-1)?.runId).not.toBe(request.runId)
    expect(received).toHaveLength(2)
    expect(matterStore.list({kind:'task'})).toHaveLength(1)
  })

  it('replays a terminal continuation through its durable receipt while live and rejects changed material order',async()=>{
    const second=gate(),received:AgentAttachment[][]=[]
    setup({async spawn(){return{async *dispatch(_text,files){received.push([...(files??[])]);if(received.length===2)await second.promise;yield result},async close(){second.resolve()}}}})
    const task=workbench.create({path:project,providerId:'claude',text:'start'});await settled(task.id)
    const a=upload(task.id),b=upload(task.id,'owner',a.draftId,'第二张.png'),request={draftId:a.draftId,attachmentIds:[a.attachment.id,b.attachment.id],requestId:randomUUID()}
    const accepted=await service.say(task.id,'','phone',request)
    await expect.poll(()=>received.length).toBe(2)
    const replay=await service.say(task.id,'','phone',request)
    expect(accepted).toMatchObject({input:{id:request.requestId,attachments:[a.attachment,b.attachment]}})
    expect(replay.kind==='task'&&replay.input?.runId).toBe(accepted.kind==='task'&&accepted.input?.runId)
    expect(received[1]?.map(file=>file.name)).toEqual(['参考.png','第二张.png'])
    await expect(service.say(task.id,'','phone',{...request,attachmentIds:[b.attachment.id,a.attachment.id]})).rejects.toThrow('input_conflict')
    expect(received).toHaveLength(2)
    second.resolve();await settled(task.id)
  })

  it('preserves held as unconfirmed in details and in a retry after daemon recovery',async()=>{
    const first=gate();let calls=0
    const provider:AgentProvider={async spawn(){return{async *dispatch(){calls++;await first.promise;yield result},async close(){first.resolve()}}}}
    setup(provider)
    const task=workbench.create({path:project,providerId:'claude',text:'start'});await expect.poll(()=>calls).toBe(1)
    const material=upload(task.id),request={...material,runId:workbench.detail(task.id).runId!,requestId:randomUUID()}
    await service.say(task.id,'','phone',request)
    await workbench.shutdown()
    setup(provider)
    expect((await service.detail(task.id)).inputs).toMatchObject([{id:request.requestId,runId:request.runId,status:'held',attachments:[material.attachment]}])
    expect(await service.say(task.id,'','phone',request)).toMatchObject({input:{id:request.requestId,runId:request.runId,status:'held',attachments:[material.attachment]}})
    expect(calls).toBe(1)
  })

  it('rejects foreign owner, foreign draft, and foreign task materials without recording an input',async()=>{
    setup({async spawn(){return{async *dispatch(){yield result},async close(){}}}})
    const task=workbench.create({path:project,providerId:'claude',text:'start'});await settled(task.id)
    const own=upload(task.id),foreign=upload(undefined,'other-owner')
    await expect(service.say(task.id,'看图','phone',{...foreign,requestId:randomUUID()})).rejects.toThrow('attachment_scope')
    await expect(service.say(task.id,'看图','phone',{...own,draftId:randomUUID(),requestId:randomUUID()})).rejects.toThrow('attachment_scope')
    const other=workbench.create({path:project,providerId:'claude',text:'other'});await settled(other.id)
    await expect(service.say(other.id,'看图','phone',{...own,requestId:randomUUID()})).rejects.toThrow('attachment_scope')
    expect(store.liveInputs.list(task.id)).toEqual([])
    expect(store.liveInputs.list(other.id)).toEqual([])
  })

  it.each([
    {attachmentIds:'not-an-array'},
    {attachmentIds:['bad-id']},
    {attachmentIds:[],draftId:'bad-id'},
    {attachmentIds:Array.from({length:9},()=>randomUUID())},
  ])('rejects malformed materials at the existing workbench boundary: %j',async malformed=>{
    setup({async spawn(){return{async *dispatch(){yield result},async close(){}}}})
    const task=workbench.create({path:project,providerId:'claude',text:'start'});await settled(task.id)
    await expect(service.say(task.id,'看图','phone',{...malformed,requestId:randomUUID()} as never)).rejects.toThrow('invalid_attachment')
    expect(store.liveInputs.list(task.id)).toEqual([])
  })

  it.each(['restart_confirmation_required','external_close_confirmation_required'])('preserves %s and does not manufacture an accepted material receipt',async error=>{
    const task={id:'deadbeef',title:'t',status:'completed',providerId:'claude',path:project,error:null,updatedAt:1}
    matterStore.create({id:task.id,kind:'task',title:'t',status:'done'})
    const continueTask=vi.fn<NonNullable<MattersServiceDeps['workbench']>['continueTask']>(()=>{throw Error(error)}),material=upload()
    service=makeMattersService({store:matterStore,workbench:{detail:()=>({task,events:[]}),continueTask}})
    await expect(service.say(task.id,'','phone',{...material,requestId:randomUUID()})).rejects.toThrow(error)
    expect(matterStore.get(task.id)?.status).toBe('done')
    expect(continueTask.mock.calls[0]?.[2]).not.toHaveProperty('restartToken')
  })

  it('rejects material-bearing chat messages instead of silently dropping their attachments',async()=>{
    const chat=matterStore.ensureChat('owner'),say=vi.fn(async()=>({reply:'reply'})),material=upload()
    service=makeMattersService({store:matterStore,chat:{ownerChatId:()=>'owner',say}})
    await expect(service.say(chat.id,'附图','phone',{...material,requestId:randomUUID()})).rejects.toThrow('matter_say_unsupported')
    expect(say).not.toHaveBeenCalled()
  })

  it('returns a terminal receipt for a valid uppercase UUID using its canonical identity',async()=>{
    setup({async spawn(){return{async *dispatch(){yield result},async close(){}}}})
    const task=workbench.create({path:project,providerId:'claude',text:'start'});await settled(task.id)
    const material=upload(task.id),request={...material,requestId:randomUUID().toUpperCase()}
    expect(await service.say(task.id,'','phone',request)).toMatchObject({input:{id:request.requestId.toLowerCase(),attachments:[material.attachment]}})
    await settled(task.id)
  })

  it('derives the owner policy from the surface and forwards only declared live input fields',async()=>{
    const task={id:'deadbeef',title:'t',status:'running',providerId:'claude',path:project,error:null,updatedAt:1},requestId=randomUUID(),runId=randomUUID(),material=upload()
    matterStore.create({id:task.id,kind:'task',title:'t'})
    const submitInput=vi.fn<NonNullable<NonNullable<MattersServiceDeps['workbench']>['submitInput']>>(async()=>({id:requestId,taskId:task.id,runId,text:'',status:'held',createdAt:1,error:null,attachments:[material.attachment]}))
    service=makeMattersService({store:matterStore,workbench:{detail:()=>({task,runId,events:[]}),continueTask:()=>task,submitInput}})
    const request={...material,requestId,runId,ownerKey:'other-owner',attachmentPolicy:'legacy',restartToken:'do not forward'}
    await service.say(task.id,'','phone',request)
    expect(submitInput).toHaveBeenLastCalledWith(task.id,{requestId,runId,text:'',draftId:material.draftId,attachmentIds:material.attachmentIds},'owner')
    await service.say(task.id,'','desktop',request)
    expect(submitInput).toHaveBeenLastCalledWith(task.id,{requestId,runId,text:'',draftId:material.draftId,attachmentIds:material.attachmentIds})
  })

  it('rejects unbound legacy material from phone but permits already-bound legacy material owned by the same task',async()=>{
    setup({async spawn(){return{async *dispatch(){yield result},async close(){}}}})
    const task=workbench.create({path:project,providerId:'claude',text:'start'});await settled(task.id)
    const legacy=upload(undefined,null),request={...legacy,requestId:randomUUID()}
    await expect(service.say(task.id,'','phone',request)).rejects.toThrow('attachment_scope')
    expect(store.liveInputs.list(task.id)).toHaveLength(0)
    store.attachments.bind(legacy.attachmentIds,task.id,legacy.draftId)
    expect(await service.say(task.id,'','phone',request)).toMatchObject({input:{attachments:[legacy.attachment]}})
    await settled(task.id)
  })
})
