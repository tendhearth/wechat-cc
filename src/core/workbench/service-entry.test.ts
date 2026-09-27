import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {randomUUID} from 'node:crypto'
import {mkdirSync,mkdtempSync,realpathSync,renameSync,writeFileSync,unlinkSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {openDb,type Db} from '../../lib/db'
import {removeTempDir} from '../../lib/test-temp'
import {createProviderRegistry} from '../provider-registry'
import {makeMatterStore} from '../matters/store'
import {makeWorkbenchStore} from './store'
import {makeWorkbenchService,type WorkbenchService} from './service'
import {MANAGED_NATIVE_CAPABILITIES,UNATTENDED_CAPABILITIES} from './executor-capabilities'
import {makeTaskChangeHub} from './task-changes'
import {canonicalEntryHash,type EntryInput} from './task-entry'
import {validateApiTaskInput} from './api-task-provider'

let area:string,stateDir:string,project:string,db:Db,store:ReturnType<typeof makeWorkbenchStore>,service:WorkbenchService
let owner:string|null,spawnCount:number,mintCount:number,seen:string[],hub:ReturnType<typeof makeTaskChangeHub>
const context={ownerKey:'owner',surface:'desktop' as const}
const input=(changes:Partial<EntryInput>={}):EntryInput=>({requestId:randomUUID(),text:'整理一份周报',target:{kind:'managed'},...changes})
function setup(defaultProvider='claude',ids=['claude','codex']){
  const registry=createProviderRegistry()
  for(const id of ids)registry.register(id,{async spawn(){spawnCount++;return{
    async *dispatch(text){seen.push(text);yield{kind:'text' as const,text:'完成'};yield{kind:'result' as const,sessionId:'native',numTurns:1,durationMs:1}},async close(){},
  }}},{displayName:id,canResume:()=>true,workbench:id==='unattended'?UNATTENDED_CAPABILITIES:MANAGED_NATIVE_CAPABILITIES,...(id==='openai'?{validateWorkbenchInput:validateApiTaskInput}:{})})
  store=makeWorkbenchStore(db);hub=makeTaskChangeHub()
  service=makeWorkbenchService({store,registry,stateDir,managedWorkspaceRoot:join(area,'Tasks'),ownerChatId:()=>owner,defaultProvider,
    registeredProjects:()=>[{alias:'project',path:project}],matters:makeMatterStore(db),changes:hub,mintSessionToken:()=>{mintCount++;return'test-token'}})
}
beforeEach(()=>{
  area=realpathSync(mkdtempSync(join(tmpdir(),'cc-entry-service-')));stateDir=join(area,'state');project=join(area,'project');mkdirSync(stateDir);mkdirSync(project)
  db=openDb({path:join(stateDir,'state.db')});owner='owner';spawnCount=0;mintCount=0;seen=[];setup()
})
afterEach(async()=>{vi.restoreAllMocks();await service?.shutdown();db.close();removeTempDir(area)})
const settle=async(id:string)=>expect.poll(()=>service.detail(id).task.status).toBe('completed')
const staged=()=>{
  const draftId=randomUUID(),id=randomUUID()
  const attachment=store.attachments.upload({id,draftId,name:'notes.txt',mime:'text/plain',base64:Buffer.from('original material').toString('base64')},stateDir,{ownerKey:'owner'})
  return{draftId,attachmentIds:[id],attachment}
}

it('creates one task, matter, first user event and run across desktop/phone retries',async()=>{
  const request=input(),first=service.createEntry(request,context)
  expect(service.createEntry(request,{...context,surface:'phone'}).receipt).toEqual(first.receipt)
  expect(first.task.workspaceKind).toBe('managed');expect(first.receipt.taskId).toBe(first.receipt.matterId)
  expect(service.entryReceipt(request.requestId,context)?.receipt).toEqual(first.receipt)
  const counts=['workbench_tasks','matters','workbench_events','workbench_run_execution'].map(table=>db.query<{n:number},[]>(`SELECT count(*) AS n FROM ${table}`).get()!.n)
  expect(counts).toEqual([1,1,1,1]);expect(store.projects()).toEqual([])
  expect(makeMatterStore(db).bindings(first.receipt.matterId)).toEqual([expect.objectContaining({surface:'desktop',surfaceKey:'owner'})])
  await settle(first.receipt.taskId);expect(spawnCount).toBe(1)
})

it('replays before looking at moved directories, removed materials or changed defaults after restart',async()=>{
  const material=staged(),request=input({draftId:material.draftId,attachmentIds:material.attachmentIds}),first=service.createEntry(request,context);await settle(first.receipt.taskId)
  await service.shutdown();db.close();db=openDb({path:join(stateDir,'state.db')});setup('codex',['codex'])
  renameSync(first.task.path,first.task.path+'-moved')
  unlinkSync(join(stateDir,'workbench-attachments',material.attachment.sha256))
  expect(service.createEntry(request,context).receipt).toEqual(first.receipt)
  expect(service.entryReceipt(request.requestId,context)?.receipt).toEqual(first.receipt)
  expect(spawnCount).toBe(1);expect(store.list()).toHaveLength(1)
})

it('rejects changed text, excerpts, execution settings and ordered materials for one request',async()=>{
  const first=staged(),secondId=randomUUID()
  store.attachments.upload({id:secondId,draftId:first.draftId,name:'second.txt',mime:'text/plain',base64:'YQ=='},stateDir,{ownerKey:'owner'})
  const request=input({draftId:first.draftId,attachmentIds:[...first.attachmentIds,secondId]})
  const accepted=service.createEntry(request,context)
  for(const changes of [{text:'different'},{context:{source:'owner-chat' as const,excerpts:[{role:'user' as const,text:'selected'}]}},{execution:{defaults:'provider'}},{attachmentIds:[secondId,...first.attachmentIds]}]) {
    expect(()=>service.createEntry({...request,...changes},context)).toThrow('creation_conflict')
  }
  await settle(accepted.receipt.taskId);expect(store.list()).toHaveLength(1)
})

it.each(['matter','binding','receipt','outer-commit'])('rolls back %s failure with no spawn, token, notification or consumed material',async(point)=>{
  const material=staged(),request=input({draftId:material.draftId,attachmentIds:material.attachmentIds}),published=vi.spyOn(hub,'publish')
  if(point==='matter')db.exec("CREATE TRIGGER entry_fault BEFORE INSERT ON matters BEGIN SELECT RAISE(ABORT,'entry_fault'); END")
  if(point==='binding')db.exec("CREATE TRIGGER entry_fault BEFORE INSERT ON matter_bindings BEGIN SELECT RAISE(ABORT,'entry_fault'); END")
  if(point==='receipt')db.exec("CREATE TRIGGER entry_fault BEFORE UPDATE OF phase ON workbench_entry_requests BEGIN SELECT RAISE(ABORT,'entry_fault'); END")
  if(point==='outer-commit'){
    const atomic=store.atomic;let depth=0
    vi.spyOn(store,'atomic').mockImplementation(operation=>{depth++;try{return atomic(()=>{const result=operation();if(depth===1)throw Error('entry_fault');return result})}finally{depth--}})
  }
  expect(()=>service.createEntry(request,context)).toThrow('entry_fault')
  await Promise.resolve();expect(spawnCount).toBe(0);expect(mintCount).toBe(0);expect(published).not.toHaveBeenCalled()
  for(const table of ['workbench_tasks','matters','workbench_events','workbench_run_execution','matter_bindings'])expect(db.query(`SELECT * FROM ${table}`).all()).toEqual([])
  expect(store.attachments.select(material.attachmentIds,undefined,material.draftId,{ownerKey:'owner'})).toEqual([material.attachment])
  expect(store.entryRequests.get('owner',request.requestId)?.phase).toBe('reserved')
  if(point!=='outer-commit')db.exec('DROP TRIGGER entry_fault');else vi.restoreAllMocks()
  const retried=service.createEntry(request,context);await settle(retried.receipt.taskId);expect(spawnCount).toBe(1)
})

it.each(['replacement','unknown-file'])('freezes a reserved provider and directory, then rejects %s in that directory',async(change)=>{
  const request=input();db.exec("CREATE TRIGGER entry_fault BEFORE INSERT ON matters BEGIN SELECT RAISE(ABORT,'entry_fault'); END")
  expect(()=>service.createEntry(request,context)).toThrow('entry_fault')
  const reserved=store.entryRequests.get('owner',request.requestId)!
  expect(reserved.providerId).toBe('claude')
  db.exec('DROP TRIGGER entry_fault');await service.shutdown();setup('codex')
  if(change==='replacement'){renameSync(reserved.resolvedPath!,reserved.resolvedPath!+'-old');mkdirSync(reserved.resolvedPath!)}
  writeFileSync(join(reserved.resolvedPath!,'foreign.txt'),'foreign')
  expect(()=>service.createEntry(request,context)).toThrow('managed_workspace_changed')
  expect(store.entryRequests.get('owner',request.requestId)?.providerId).toBe('claude');expect(spawnCount).toBe(0)
})

it('keeps reserved execution when defaults change and creates no second workspace',async()=>{
  const request=input();db.exec("CREATE TRIGGER entry_fault BEFORE INSERT ON matters BEGIN SELECT RAISE(ABORT,'entry_fault'); END")
  expect(()=>service.createEntry(request,context)).toThrow('entry_fault')
  const reserved=store.entryRequests.get('owner',request.requestId)!
  db.exec('DROP TRIGGER entry_fault');await service.shutdown();setup('codex')
  const result=service.createEntry(request,context);expect(result.task.providerId).toBe('claude');expect(result.task.path).toBe(reserved.resolvedPath)
  await settle(result.receipt.taskId)
})

it('accepts only current owner catalog IDs and explicitly selected discussion',async()=>{
  const request=input({target:{kind:'project',projectId:service.projects()[0]!.id},context:{source:'owner-chat',excerpts:[{role:'assistant',text:'only selected material'}]}})
  const result=service.createEntry(request,context);await settle(result.receipt.taskId)
  expect(result.task.path).toBe(project);expect(result.task.workspaceKind).toBe('project')
  expect(seen[0]).toContain('only selected material');expect(seen[0]).toContain('主人选择的讨论材料')
  const matter=makeMatterStore(db).get(result.receipt.matterId)!
  expect(makeMatterStore(db).get(matter.originMatterId!)?.ownerChatId).toBe('owner');expect(matter.originMessageId).toBeNull()
  expect(()=>service.createEntry(input({target:{kind:'project',projectId:'p-'+'a'.repeat(20)}}),context)).toThrow('project_stale')
  owner='new-owner';expect(()=>service.entryReceipt(request.requestId,context)).toThrow('invalid_entry_owner')
  expect(service.entryReceipt(request.requestId,{ownerKey:'new-owner',surface:'phone'})).toBeNull()
})

it('keeps missing identity/provider and unconfirmed unattended choices explicit',async()=>{
  owner=null;expect(service.entryOptions(context).status).toBe('needs_connection')
  expect(()=>service.createEntry(input(),context)).toThrow('invalid_entry_owner')
  owner='owner';await service.shutdown();setup('missing',['codex','unattended'])
  expect(service.entryOptions(context)).toMatchObject({status:'needs_connection',defaultProviderId:null})
  expect(()=>service.createEntry(input(),context)).toThrow('unavailable_provider')
  expect(()=>service.createEntry(input({providerId:'unattended'}),context)).toThrow('unattended_ack_required')
  expect(store.list()).toEqual([])
})

it('accepts owner-stamped material-only input while rejecting unbound legacy and foreign materials',async()=>{
  const material=staged();owner='other'
  expect(()=>service.createEntry(input({draftId:material.draftId,attachmentIds:material.attachmentIds}),{ownerKey:'other',surface:'phone'})).toThrow('attachment_scope')
  owner='owner';const legacy={id:randomUUID(),draftId:randomUUID(),name:'legacy.txt',mime:'text/plain',base64:'YQ=='}
  store.attachments.upload(legacy,stateDir)
  expect(()=>service.createEntry(input({text:'',draftId:legacy.draftId,attachmentIds:[legacy.id]}),context)).toThrow('attachment_scope')
  const request=input({text:'',draftId:material.draftId,attachmentIds:material.attachmentIds}),result=service.createEntry(request,context)
  await settle(result.receipt.taskId);expect(service.detail(result.receipt.taskId).events.find(e=>e.kind==='user')?.attachments).toEqual([material.attachment])
})

it.each(['allocation','first material check'])('reuses the winner when another connection commits during %s',async(point)=>{
  const secondDb=openDb({path:join(stateDir,'state.db')}),secondStore=makeWorkbenchStore(secondDb),registry=createProviderRegistry()
  registry.register('claude',{async spawn(){spawnCount++;return{async *dispatch(){yield{kind:'result' as const,sessionId:'second',numTurns:1,durationMs:1}},async close(){}}}},
    {displayName:'Claude',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  const other=makeWorkbenchService({store:secondStore,registry,stateDir,managedWorkspaceRoot:join(area,'Tasks'),ownerChatId:()=>owner,defaultProvider:'claude',matters:makeMatterStore(secondDb)})
  try{
    const material=staged(),request=input({draftId:material.draftId,attachmentIds:material.attachmentIds}),allocate=store.entryRequests.allocate,verify=store.attachments.verify
    let winner:ReturnType<typeof other.createEntry>|undefined
    if(point==='allocation')vi.spyOn(store.entryRequests,'allocate').mockImplementation((...args)=>{const reserved=allocate(...args);winner=other.createEntry(request,{...context,surface:'phone'});return reserved})
    else vi.spyOn(store.attachments,'verify').mockImplementationOnce((...args)=>{winner=other.createEntry(request,{...context,surface:'phone'});return verify(...args)})
    const result=service.createEntry(request,context)
    expect(result.receipt).toEqual(winner!.receipt)
    for(const table of ['workbench_tasks','matters','workbench_events','workbench_run_execution'])expect(db.query(`SELECT * FROM ${table}`).all()).toHaveLength(1)
    await expect.poll(()=>other.detail(result.receipt.taskId).task.status).toBe('completed');expect(spawnCount).toBe(1)
  }finally{await other.shutdown();secondDb.close()}
})

it('recovers an accepted commit without activation as interrupted, never creating it again',async()=>{
  const request=input({target:{kind:'project',projectId:service.projects()[0]!.id}}),runId=randomUUID()
  const reservation=store.entryRequests.reserve({ownerKey:'owner',requestId:request.requestId,canonicalRequestHash:canonicalEntryHash(request),target:request.target,
    workspaceId:null,resolvedPath:project,directoryIdentity:'fixture:identity',providerId:'claude',execution:{defaults:'provider',model:null,reasoningEffort:null},materialSnapshot:[]})
  const receipt=store.atomic(()=>{
    const task=store.create({path:project,title:'committed',providerId:'claude',ownerChatId:'owner'}),matters=makeMatterStore(db)
    matters.create({id:task.id,kind:'task',title:task.title,ownerChatId:'owner'});matters.linkTask(task.id);matters.bind(task.id,'desktop','owner')
    store.execution.accept(task.id,runId,reservation.execution);store.addEvent(task.id,'user',request.text,null,runId)
    return store.entryRequests.accept('owner',request.requestId,{taskId:task.id,matterId:task.id,runId,acceptedAt:Date.now(),resolvedPath:project,directoryIdentity:'fixture:identity'})
  })
  await service.shutdown();db.close();db=openDb({path:join(stateDir,'state.db')});setup('codex')
  const result=service.createEntry(request,context)
  expect(result.receipt.taskId).toBe(receipt.taskId);expect(result.receipt.runId).toBe(runId);expect(result.task.status).toBe('interrupted')
  expect(spawnCount).toBe(0);expect(store.list()).toHaveLength(1)
})

it('refuses changed staged bytes before reserving or launching a task',()=>{
  const material=staged();writeFileSync(join(stateDir,'workbench-attachments',material.attachment.sha256),'tampered bytes')
  const request=input({draftId:material.draftId,attachmentIds:material.attachmentIds})
  expect(()=>service.createEntry(request,context)).toThrow('attachment_changed')
  expect(store.entryRequests.get('owner',request.requestId)).toBeNull();expect(store.list()).toEqual([]);expect(spawnCount).toBe(0)
})

it('requires current capabilities again for a reservation and never substitutes an available provider',async()=>{
  const request=input();db.exec("CREATE TRIGGER entry_fault BEFORE INSERT ON matters BEGIN SELECT RAISE(ABORT,'entry_fault'); END")
  expect(()=>service.createEntry(request,context)).toThrow('entry_fault')
  db.exec('DROP TRIGGER entry_fault');await service.shutdown();setup('codex',['codex'])
  expect(()=>service.createEntry(request,context)).toThrow('unavailable_provider')
  expect(store.entryRequests.get('owner',request.requestId)?.providerId).toBe('claude');expect(store.list()).toEqual([])
})

it('keeps legacy direct creation compatible but enforces stamped attachment owners there too',async()=>{
  const material=staged(),legacy={id:randomUUID(),draftId:randomUUID(),name:'legacy.txt',mime:'text/plain',base64:'YQ=='}
  store.attachments.upload(legacy,stateDir)
  const old=service.create({path:project,providerId:'claude',text:'legacy',draftId:legacy.draftId,attachmentIds:[legacy.id]});await settle(old.id)
  owner='other'
  expect(()=>service.create({path:project,providerId:'claude',text:'foreign',draftId:material.draftId,attachmentIds:material.attachmentIds})).toThrow('attachment_scope')
  owner='owner'
  const current=service.create({path:project,providerId:'claude',text:'own',draftId:material.draftId,attachmentIds:material.attachmentIds});await settle(current.id)
  expect(store.list()).toHaveLength(2)
})

it('accepts a picture without text as the first public user material',async()=>{
  const draftId=randomUUID(),id=randomUUID(),png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII='
  const attachment=store.attachments.upload({id,draftId,name:'photo.png',mime:'image/png',base64:png},stateDir,{ownerKey:'owner'})
  const result=service.createEntry(input({text:'',draftId,attachmentIds:[id]}),context);await settle(result.receipt.taskId)
  expect(service.detail(result.receipt.taskId).events.find(e=>e.kind==='user')).toMatchObject({text:'',attachments:[attachment]})
})

it('rejects API-incompatible binary material before reservation, binding or model dispatch',async()=>{
  await service.shutdown();setup('openai',['openai'])
  const draftId=randomUUID(),id=randomUUID()
  const attachment=store.attachments.upload({id,draftId,name:'report.pdf',mime:'application/pdf',base64:Buffer.from('%PDF-1.7 data').toString('base64')},stateDir,{ownerKey:'owner'})
  const request=input({draftId,attachmentIds:[id]})
  expect(()=>service.createEntry(request,context)).toThrow('api_task_attachment_unsupported')
  expect(store.entryRequests.get('owner',request.requestId)).toBeNull();expect(spawnCount).toBe(0)
  expect(store.attachments.select([id],undefined,draftId,context)).toEqual([attachment])
})

it('expires an unaccepted creation reservation instead of reviving released material claims',()=>{
  const request=input();db.exec("CREATE TRIGGER entry_fault BEFORE INSERT ON matters BEGIN SELECT RAISE(ABORT,'entry_fault'); END")
  expect(()=>service.createEntry(request,context)).toThrow('entry_fault')
  db.exec('DROP TRIGGER entry_fault')
  db.query('UPDATE workbench_entry_requests SET created_at=? WHERE request_id=?').run(Date.now()-8*86400_000,request.requestId)
  expect(()=>service.createEntry(request,context)).toThrow('entry_expired')
  expect(store.list()).toEqual([]);expect(spawnCount).toBe(0)
})
