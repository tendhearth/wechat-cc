import {afterEach,beforeEach,expect,it} from 'vitest'
import {mkdtempSync,mkdirSync,realpathSync,rmSync,readFileSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {openDb,type Db} from '../../lib/db'
import {createProviderRegistry} from '../provider-registry'
import type {AgentAttachment,AgentEvent,AgentProvider} from '../agent-provider'
import {makeWorkbenchStore} from './store'
import {makeWorkbenchService,type WorkbenchService} from './service'
import {restartPreview} from './continuation'

let root:string,project:string,db:Db,service:WorkbenchService,store:ReturnType<typeof makeWorkbenchStore>
const result:AgentEvent={kind:'result',sessionId:'native-session',numTurns:1,durationMs:1}
function setup(provider:AgentProvider,resume=true){
  const registry=createProviderRegistry()
  for(const id of ['claude','codex'] as const)registry.register(id,provider,{displayName:id,canResume:()=>resume})
  store=makeWorkbenchStore(db);service=makeWorkbenchService({store,registry,stateDir:root,ownerChatId:()=>null})
}
function gate(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return{promise,resolve}}
function upload(name='brief.txt',text='original input',taskId?:string){
  const draftId=randomUUID(),id=randomUUID()
  const attachment=service.uploadAttachment({id,draftId,taskId,name,mime:'text/plain',base64:Buffer.from(text).toString('base64')})
  return {attachment,draftId,attachmentIds:[id]}
}
async function settled(id:string){await expect.poll(()=>service.detail(id).task.status).not.toMatch(/^(queued|running|cancelling)$/)}
beforeEach(()=>{root=realpathSync(mkdtempSync(join(tmpdir(),'cc-attachment-service-')));project=join(root,'project');mkdirSync(project);db=openDb({path:join(root,'state.db')})})
afterEach(async()=>{await service?.shutdown();db.close();rmSync(root,{recursive:true,force:true})})

it('dispatches attachment-only input as pinned material and binds it to the user event',async()=>{
  const received:AgentAttachment[][]=[]
  setup({async spawn(){return{async *dispatch(_text,files){received.push([...(files??[])]);yield result},async close(){}}}})
  const input=upload(),task=service.create({path:project,providerId:'claude',text:'',...input})
  await settled(task.id)
  expect(received[0]).toHaveLength(1)
  expect(readFileSync(received[0]![0]!.path,'utf8')).toBe('original input')
  const event=service.detail(task.id).events.find(e=>e.kind==='user')!
  expect(event.attachments).toEqual([input.attachment]);expect(event.runId).toBeTruthy()
  expect(service.readAttachment(task.id,input.attachment.id).base64).toBe(Buffer.from('original input').toString('base64'))
  const other=service.create({path:project,providerId:'codex',text:'other'});await settled(other.id)
  expect(()=>service.continueTask(other.id,'wrong task',{attachmentIds:input.attachmentIds})).toThrow()
})

it('keeps original receipt run identity when queued Claude input is delivered by a later run',async()=>{
  const first=gate(),received:AgentAttachment[][]=[]
  setup({async spawn(){return{async *dispatch(_text,files){received.push([...(files??[])]);if(received.length===1)await first.promise;yield result},async close(){first.resolve()}}}})
  const task=service.create({path:project,providerId:'claude',text:'start'});await expect.poll(()=>received.length).toBe(1)
  const input=upload('next.txt','next material',task.id),runId=service.detail(task.id).runId!,requestId=randomUUID()
  const request={runId,requestId,text:'',...input}
  expect(await service.submitInput(task.id,request)).toMatchObject({status:'pending',attachments:[input.attachment]})
  first.resolve();await expect.poll(()=>received.length).toBe(2);await settled(task.id)
  const receipt=await service.submitInput(task.id,request)
  expect(receipt).toMatchObject({runId,status:'delivered',attachments:[input.attachment]})
  expect(service.detail(task.id).events.filter(e=>e.kind==='user').at(-1)?.runId).not.toBe(runId)
  expect(readFileSync(received[1]![0]!.path,'utf8')).toBe('next material')
  await expect(service.submitInput(task.id,{...request,text:'changed',attachmentIds:[]})).rejects.toThrow('input_conflict')
})

it('acknowledges steer once with the correct run and refuses changed attachment retries',async()=>{
  const pending=gate(),steers:AgentAttachment[][]=[]
  setup({async spawn(){return{async *dispatch(){yield {kind:'init',sessionId:'native-session'};await pending.promise;yield result},async steer(_text,files){steers.push([...(files??[])])},async close(){pending.resolve()}}}})
  const task=service.create({path:project,providerId:'codex',text:'start'});await expect.poll(()=>service.detail(task.id).inputMode).toBe('steer')
  const input=upload('a.txt','A',task.id),other=upload('b.txt','B',task.id),runId=service.detail(task.id).runId!,request={...input,text:'look',runId,requestId:randomUUID()}
  await service.submitInput(task.id,request);await service.submitInput(task.id,request)
  expect(steers).toHaveLength(1)
  expect(store.events(task.id).at(-1)).toMatchObject({kind:'user',runId,attachments:[input.attachment]})
  await expect(service.submitInput(task.id,{...request,attachmentIds:other.attachmentIds,draftId:other.draftId})).rejects.toThrow('input_conflict')
})

it('pins attachment identities in restart preview and resends only covered historical material',async()=>{
  const received:AgentAttachment[][]=[]
  setup({async spawn(){return{async *dispatch(_text,files){received.push([...(files??[])]);yield result},async close(){}}}},false)
  const input=upload(),task=service.create({path:project,providerId:'claude',text:'read',...input});await settled(task.id)
  const preview=restartPreview(store.get(task.id),store.events(task.id))
  expect(preview.attachments).toEqual([input.attachment])
  const altered=store.events(task.id).map(e=>({...e,attachments:e.attachments?.map(a=>({...a,sha256:'f'.repeat(64)}))}))
  expect(restartPreview(store.get(task.id),altered).token).not.toBe(preview.token)
  service.continueTask(task.id,'continue',{restartToken:preview.token});await settled(task.id)
  expect(received[1]?.map(a=>a.sha256)).toEqual([input.attachment.sha256])
})

it('keeps first/second attachment ordering in a restart preview',async()=>{
  setup({async spawn(){return{async *dispatch(){yield result},async close(){}}}},false)
  const first=upload('first.txt','first'),second=service.uploadAttachment({id:randomUUID(),draftId:first.draftId,name:'second.txt',mime:'text/plain',base64:Buffer.from('second').toString('base64')})
  const task=service.create({path:project,providerId:'claude',text:'compare the first and second',draftId:first.draftId,attachmentIds:[first.attachment.id,second.id]});await settled(task.id)
  expect(restartPreview(store.get(task.id),store.events(task.id)).attachments?.map(a=>a.name)).toEqual(['first.txt','second.txt'])
})

it('rejects snapshot corruption after queueing before dispatching the affected input',async()=>{
  const pending=gate(),seen:string[]=[]
  setup({async spawn(){return{async *dispatch(text){seen.push(text);if(seen.length===1)await pending.promise;yield result},async close(){pending.resolve()}}}})
  const first=service.create({path:project,providerId:'claude',text:'first'});await expect.poll(()=>seen.length).toBe(1)
  const input=upload(),second=service.create({path:project,providerId:'codex',text:'second',...input})
  expect(service.detail(second.id).task.status).toBe('queued')
  writeFileSync(join(root,'workbench-attachments',input.attachment.sha256),'tampered')
  pending.resolve();await settled(first.id);await settled(second.id)
  expect(seen).toEqual(['first']);expect(service.detail(second.id).task.status).toBe('failed')
  expect(service.detail(second.id).events.find(e=>e.kind==='user')?.attachments).toEqual([input.attachment])
})

it('holds undelivered attachment receipts across daemon restart without replaying them',async()=>{
  const pending=gate(),seen:string[]=[]
  const provider:AgentProvider={async spawn(){return{async *dispatch(text){seen.push(text);await pending.promise;yield result},async close(){pending.resolve()}}}}
  setup(provider)
  const task=service.create({path:project,providerId:'claude',text:'first'});await expect.poll(()=>seen.length).toBe(1)
  const input=upload('pending.txt','keep this',task.id),requestId=randomUUID(),runId=service.detail(task.id).runId!
  await service.submitInput(task.id,{runId,requestId,text:'later',...input})
  await service.shutdown();db.close();db=openDb({path:join(root,'state.db')});setup(provider)
  const receipt=store.liveInputs.get(requestId)!
  expect(receipt).toMatchObject({runId,status:'held',attachments:[input.attachment]})
  expect(service.readAttachment(task.id,input.attachment.id).base64).toBe(Buffer.from('keep this').toString('base64'))
  expect(seen).toEqual(['first'])
})

it('handoff creates task-owned copies of selected inputs and pins originals through revision',async()=>{
  const received:AgentAttachment[][]=[]
  setup({async spawn(){return{async *dispatch(_text,files){received.push([...(files??[])]);yield {kind:'text',text:'change the heading'};yield result},async close(){}}}})
  const input=upload(),source=service.create({path:project,providerId:'codex',text:'make report',...input});await settled(source.id)
  const selections=[{taskId:source.id,attachmentId:input.attachment.id,sha256:input.attachment.sha256}]
  const preview=await service.previewHandoff({sourceTaskId:source.id,targetProviderId:'claude',purpose:'review',request:'check',artifacts:[],attachments:selections})
  expect(preview.attachments).toEqual(selections)
  expect(preview.context).not.toContain('请按上述文字范围检查')
  const handed=await service.handoff({token:preview.token});await settled(handed.task.id)
  const copied=service.detail(handed.task.id).events.find(e=>e.kind==='user')!.attachments![0]!
  expect(copied.id).not.toBe(input.attachment.id);expect(copied.sha256).toBe(input.attachment.sha256)
  const review=store.events(handed.task.id).find(e=>e.kind==='text')!
  const back=await service.previewHandoff({sourceTaskId:handed.task.id,targetTaskId:source.id,targetProviderId:'codex',purpose:'revision',request:'apply',artifacts:[],quote:{taskId:handed.task.id,eventId:review.id,text:review.text}})
  expect(back.attachments).toEqual(selections)
  await service.handoff({token:back.token});await settled(source.id)
  expect(received.map(files=>files[0]?.sha256)).toEqual([input.attachment.sha256,input.attachment.sha256,input.attachment.sha256])
  await service.handoff({token:preview.token});expect(received).toHaveLength(3)
})
