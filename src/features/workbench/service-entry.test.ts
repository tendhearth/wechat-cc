import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { readdirSync } from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {randomUUID} from 'node:crypto'
import {existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,renameSync,writeFileSync,unlinkSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {openDb,type Db} from '../../lib/db'
import {removeTempDir} from '../../lib/test-temp'
import {createProviderRegistry} from '../../app/provider-registry'
import {makeMatterStore} from '../../adapters/store/matters-store'
import {makeWorkbenchStore} from '../../adapters/store/workbench/store'
import {makeWorkbenchService,type WorkbenchService} from './service'
import {MANAGED_NATIVE_CAPABILITIES,UNATTENDED_CAPABILITIES} from '../../domain/workbench/executor-capabilities'
import {canonicalEntryHash,type EntryInput} from '../../adapters/workbench/task-entry'
import {validateApiTaskInput} from '../../adapters/executors/openai/openai-workbench-provider'
import {preparationJobspawnFixture} from '../../test-support/preparation-jobspawn'
import {DEPENDENCY_COPY_NOTICE} from '../../adapters/git/worktree-dependencies'

preparationJobspawnFixture()

const entryReads=vi.hoisted(()=>({observe:null as null|((count:number)=>void)}))
vi.mock('node:fs',async importOriginal=>{
  const fs=await importOriginal<typeof import('node:fs')>()
  return{...fs,readSync:(...args:unknown[])=>{const count=Reflect.apply(fs.readSync,fs,args) as number;entryReads.observe?.(count);return count}}
})
vi.mock('node:fs/promises',async importOriginal=>({...await importOriginal<typeof import('node:fs/promises')>()}))

let area:string,stateDir:string,project:string,db:Db,store:ReturnType<typeof makeWorkbenchStore>,service:WorkbenchService
let onSpawn:((path:string)=>void)|undefined
let owner:string|null,spawnCount:number,mintCount:number,seen:string[],spawnedTaskIds:(string|undefined)[]
const context={ownerKey:'owner',surface:'desktop' as const}
const input=(changes:Partial<EntryInput>={}):EntryInput=>({requestId:randomUUID(),text:'整理一份周报',target:{kind:'managed'},...changes})
function setup(defaultProvider='claude',ids=['claude','codex']){
  const registry=createProviderRegistry()
  for(const id of ids)registry.register(id,{async spawn(_project,spawnContext){onSpawn?.(_project.path);spawnCount++;spawnedTaskIds.push(spawnContext.workbenchTaskId);return{
    async *dispatch(text){seen.push(text);yield{kind:'text' as const,text:'完成'};yield{kind:'result' as const,sessionId:'native',numTurns:1,durationMs:1}},async close(){},
  }}},{displayName:id,canResume:()=>true,workbench:id==='unattended'?UNATTENDED_CAPABILITIES:MANAGED_NATIVE_CAPABILITIES,...(id==='openai'?{validateWorkbenchInput:validateApiTaskInput}:{})})
  store=makeWorkbenchStore(db)
  service=makeWorkbenchService({store,registry,stateDir,managedWorkspaceRoot:join(area,'Tasks'),ownerChatId:()=>owner,defaultProvider,
    registeredProjects:()=>[{alias:'project',path:project}],matters:makeMatterStore(db),mintSessionToken:()=>{mintCount++;return'test-token'}})
}
beforeEach(()=>{
  area=realpathSync(mkdtempSync(join(tmpdir(),'cc-entry-service-')));stateDir=join(area,'state');project=join(area,'project');mkdirSync(stateDir);mkdirSync(project)
  db=openDb({path:join(stateDir,'state.db')});owner='owner';onSpawn=undefined;spawnCount=0;mintCount=0;seen=[];spawnedTaskIds=[];setup()
})
afterEach(async()=>{vi.restoreAllMocks();await service?.shutdown();db.close();removeTempDir(area)})
// 真 git(worktree add / 基线 / 审阅 / checkpoint)的整轮在满载套件里放大好几倍:跟 service-one-session 同一个口径给足余量(10-21 负载下假红)
vi.setConfig({testTimeout:60_000})
const settle=async(id:string)=>expect.poll(()=>service.detail(id).task.status,{timeout:30_000}).toBe('completed')
const staged=()=>{
  const draftId=randomUUID(),id=randomUUID()
  const attachment=store.attachments.upload({id,draftId,name:'notes.txt',mime:'text/plain',base64:Buffer.from('original material').toString('base64')},stateDir,{ownerKey:'owner'})
  return{draftId,attachmentIds:[id],attachment}
}

it('creates one task, matter, first user event and run across desktop/phone retries',async()=>{
  const request=input(),first=(await service.createEntry(request,context))
  expect((await service.createEntry(request,{...context,surface:'phone'})).receipt).toEqual(first.receipt)
  expect(first.task.workspaceKind).toBe('managed');expect(first.receipt.taskId).toBe(first.receipt.matterId)
  expect(service.entryReceipt(request.requestId,context)?.receipt).toEqual(first.receipt)
  const counts=['workbench_tasks','matters','matter_items','matter_turns'].map(table=>db.query<{n:number},[]>(`SELECT count(*) AS n FROM ${table}`).get()!.n)
  expect(counts).toEqual([1,1,1,1]);expect(store.projects()).toEqual([])
  expect(makeMatterStore(db).bindings(first.receipt.matterId)).toEqual([expect.objectContaining({surface:'desktop',surfaceKey:'owner'})])
  await settle(first.receipt.taskId);expect(spawnCount).toBe(1)
})

it('replays before looking at moved directories, removed materials or changed defaults after restart',async()=>{
  const material=staged(),request=input({draftId:material.draftId,attachmentIds:material.attachmentIds}),first=(await service.createEntry(request,context));await settle(first.receipt.taskId)
  await service.shutdown();db.close();db=openDb({path:join(stateDir,'state.db')});setup('codex',['codex'])
  renameSync(first.task.path,first.task.path+'-moved')
  unlinkSync(join(stateDir,'workbench-attachments',material.attachment.sha256))
  expect((await service.createEntry(request,context)).receipt).toEqual(first.receipt)
  expect(service.entryReceipt(request.requestId,context)?.receipt).toEqual(first.receipt)
  expect(spawnCount).toBe(1);expect(store.list()).toHaveLength(1)
})

it('rejects changed text, excerpts, execution settings and ordered materials for one request',async()=>{
  const first=staged(),secondId=randomUUID()
  store.attachments.upload({id:secondId,draftId:first.draftId,name:'second.txt',mime:'text/plain',base64:'YQ=='},stateDir,{ownerKey:'owner'})
  const request=input({draftId:first.draftId,attachmentIds:[...first.attachmentIds,secondId]})
  const accepted=(await service.createEntry(request,context))
  for(const changes of [{text:'different'},{context:{source:'owner-chat' as const,excerpts:[{role:'user' as const,text:'selected'}]}},{execution:{defaults:'provider'}},{attachmentIds:[secondId,...first.attachmentIds]}]) {
    await expect(service.createEntry({...request,...changes},context)).rejects.toThrow('creation_conflict')
  }
  await settle(accepted.receipt.taskId);expect(store.list()).toHaveLength(1)
})

it.each(['matter','binding','receipt','outer-commit'])('rolls back %s failure with no spawn, token, notification or consumed material',async(point)=>{
  const material=staged(),request=input({draftId:material.draftId,attachmentIds:material.attachmentIds}),published=vi.fn(),unsubscribe=store.feed.onChange(published)
  if(point==='matter')db.exec("CREATE TRIGGER entry_fault BEFORE INSERT ON matters BEGIN SELECT RAISE(ABORT,'entry_fault'); END")
  if(point==='binding')db.exec("CREATE TRIGGER entry_fault BEFORE INSERT ON matter_bindings BEGIN SELECT RAISE(ABORT,'entry_fault'); END")
  if(point==='receipt')db.exec("CREATE TRIGGER entry_fault BEFORE UPDATE OF phase ON workbench_entry_requests BEGIN SELECT RAISE(ABORT,'entry_fault'); END")
  if(point==='outer-commit'){
    const atomic=store.atomic;let depth=0
    vi.spyOn(store,'atomic').mockImplementation(operation=>{depth++;try{return atomic(()=>{const result=operation();if(depth===1)throw Error('entry_fault');return result})}finally{depth--}})
  }
  await expect(service.createEntry(request,context)).rejects.toThrow('entry_fault')
  await Promise.resolve();expect(spawnCount).toBe(0);expect(mintCount).toBe(0);expect(published).not.toHaveBeenCalled()
  for(const table of ['workbench_tasks','matters','matter_items','matter_turns','matter_bindings'])expect(db.query(`SELECT * FROM ${table}`).all()).toEqual([])
  expect(store.attachments.select(material.attachmentIds,undefined,material.draftId,{ownerKey:'owner'})).toEqual([material.attachment])
  expect(store.entryRequests.get('owner',request.requestId)?.phase).toBe('reserved')
  unsubscribe()
  if(point!=='outer-commit')db.exec('DROP TRIGGER entry_fault');else vi.restoreAllMocks()
  const retried=(await service.createEntry(request,context));await settle(retried.receipt.taskId);expect(spawnCount).toBe(1)
})

it.each(['replacement','unknown-file'])('freezes a reserved provider and directory, then rejects %s in that directory',async(change)=>{
  const request=input();db.exec("CREATE TRIGGER entry_fault BEFORE INSERT ON matters BEGIN SELECT RAISE(ABORT,'entry_fault'); END")
  await expect(service.createEntry(request,context)).rejects.toThrow('entry_fault')
  const reserved=store.entryRequests.get('owner',request.requestId)!
  expect(reserved.providerId).toBe('claude')
  db.exec('DROP TRIGGER entry_fault');await service.shutdown();setup('codex')
  if(change==='replacement'){renameSync(reserved.resolvedPath!,reserved.resolvedPath!+'-old');mkdirSync(reserved.resolvedPath!)}
  writeFileSync(join(reserved.resolvedPath!,'foreign.txt'),'foreign')
  await expect(service.createEntry(request,context)).rejects.toThrow('managed_workspace_changed')
  expect(store.entryRequests.get('owner',request.requestId)?.providerId).toBe('claude');expect(spawnCount).toBe(0)
})

it('keeps reserved execution when defaults change and creates no second workspace',async()=>{
  const request=input();db.exec("CREATE TRIGGER entry_fault BEFORE INSERT ON matters BEGIN SELECT RAISE(ABORT,'entry_fault'); END")
  await expect(service.createEntry(request,context)).rejects.toThrow('entry_fault')
  const reserved=store.entryRequests.get('owner',request.requestId)!
  db.exec('DROP TRIGGER entry_fault');await service.shutdown();setup('codex')
  const result=(await service.createEntry(request,context));expect(result.task.providerId).toBe('claude');expect(result.task.path).toBe(reserved.resolvedPath)
  await settle(result.receipt.taskId)
})

it('accepts only current owner catalog IDs and explicitly selected discussion',async()=>{
  const request=input({target:{kind:'project',projectId:service.projects()[0]!.id},context:{source:'owner-chat',excerpts:[{role:'assistant',text:'only selected material'}]}})
  const result=(await service.createEntry(request,context));await settle(result.receipt.taskId)
  expect(result.task.path).toBe(project);expect(result.task.workspaceKind).toBe('project')
  expect(seen[0]).toContain('only selected material');expect(seen[0]).toContain('主人选择的讨论材料')
  const matter=makeMatterStore(db).get(result.receipt.matterId)!
  expect(makeMatterStore(db).get(matter.originMatterId!)?.ownerChatId).toBe('owner');expect(matter.originMessageId).toBe(`entry:${request.requestId}`)
  await expect(service.createEntry(input({target:{kind:'project',projectId:'p-'+'a'.repeat(20)}}),context)).rejects.toThrow('project_stale')
  owner='new-owner';expect(()=>service.entryReceipt(request.requestId,context)).toThrow('invalid_entry_owner')
  expect(service.entryReceipt(request.requestId,{ownerKey:'new-owner',surface:'phone'})).toBeNull()
})

it('records where an entry was born (2026-10-19): desktop / app / web from the trusted context; unknown ⇒ null; a retry from elsewhere never rewrites it',async()=>{
  const matters=makeMatterStore(db)
  const desktop=(await service.createEntry(input(),{...context,origin:'desktop'}));await settle(desktop.receipt.taskId)
  expect(matters.get(desktop.receipt.matterId)?.origin).toBe('desktop')
  expect(service.detail(desktop.receipt.taskId).task.origin).toBe('desktop')
  expect(service.list().tasks.find(t=>t.id===desktop.receipt.taskId)?.origin).toBe('desktop')
  const app=input(),fromApp=(await service.createEntry(app,{ownerKey:'owner',surface:'phone',origin:'app'}));await settle(fromApp.receipt.taskId)
  expect(matters.get(fromApp.receipt.matterId)?.origin).toBe('app')
  // 同一个 requestId 从浏览器重发:回同一张回执,出生地不变
  expect((await service.createEntry(app,{ownerKey:'owner',surface:'phone',origin:'web'})).receipt).toEqual(fromApp.receipt)
  expect(matters.get(fromApp.receipt.matterId)?.origin).toBe('app')
  const web=(await service.createEntry(input(),{ownerKey:'owner',surface:'phone',origin:'web'}));await settle(web.receipt.taskId)
  expect(matters.get(web.receipt.matterId)?.origin).toBe('web')
  // 手机请求分不清 App / 浏览器(不在手机面板里调)⇒ 不写
  const unknown=(await service.createEntry(input(),{ownerKey:'owner',surface:'phone'}));await settle(unknown.receipt.taskId)
  expect(matters.get(unknown.receipt.matterId)).not.toHaveProperty('origin')
  expect(service.detail(unknown.receipt.taskId).task).not.toHaveProperty('origin')
  // 从主人对话里交办:首建的那条主人对话也记同一个出生地
  const withChat=(await service.createEntry(input({context:{source:'owner-chat',excerpts:[{role:'user',text:'这一段'}]}}),{ownerKey:'owner',surface:'phone',origin:'app'}));await settle(withChat.receipt.taskId)
  expect(matters.get(matters.get(withChat.receipt.matterId)!.originMatterId!)?.origin).toBe('app')
})

it('keeps the entry surface strict: an origin that does not belong to the surface is refused like a wrong owner',async ()=>{
  for(const bad of [{surface:'desktop',origin:'app'},{surface:'desktop',origin:'web'},{surface:'phone',origin:'desktop'},{surface:'phone',origin:'wechat'},{surface:'phone',origin:'cli'},{surface:'phone',origin:'phone'}] as const){
    await expect(service.createEntry(input(),{ownerKey:'owner',...bad} as never)).rejects.toThrow('invalid_entry_owner')
    expect(()=>service.entryReceipt(randomUUID(),{ownerKey:'owner',...bad} as never)).toThrow('invalid_entry_owner')
  }
  expect(store.list()).toEqual([])
})

it('keeps missing identity/provider and unconfirmed unattended choices explicit',async()=>{
  owner=null;expect(service.entryOptions(context).status).toBe('needs_connection')
  await expect(service.createEntry(input(),context)).rejects.toThrow('invalid_entry_owner')
  owner='owner';await service.shutdown();setup('missing',['codex','unattended'])
  expect(service.entryOptions(context)).toMatchObject({status:'needs_connection',defaultProviderId:null})
  await expect(service.createEntry(input(),context)).rejects.toThrow('unavailable_provider')
  await expect(service.createEntry(input({providerId:'unattended'}),context)).rejects.toThrow('unattended_ack_required')
  expect(store.list()).toEqual([])
})

it('accepts owner-stamped material-only input while rejecting unbound legacy and foreign materials',async()=>{
  const material=staged();owner='other'
  await expect(service.createEntry(input({draftId:material.draftId,attachmentIds:material.attachmentIds}),{ownerKey:'other',surface:'phone'})).rejects.toThrow('attachment_scope')
  owner='owner';const legacy={id:randomUUID(),draftId:randomUUID(),name:'legacy.txt',mime:'text/plain',base64:'YQ=='}
  store.attachments.upload(legacy,stateDir)
  await expect(service.createEntry(input({text:'',draftId:legacy.draftId,attachmentIds:[legacy.id]}),context)).rejects.toThrow('attachment_scope')
  const request=input({text:'',draftId:material.draftId,attachmentIds:material.attachmentIds}),result=(await service.createEntry(request,context))
  await settle(result.receipt.taskId);expect(service.detail(result.receipt.taskId).events.find(e=>e.kind==='user')?.attachments).toEqual([material.attachment])
})

it.each(['allocation','first material check'])('reuses the winner when another connection commits during %s',async(point)=>{
  const secondDb=openDb({path:join(stateDir,'state.db')}),secondStore=makeWorkbenchStore(secondDb),registry=createProviderRegistry()
  registry.register('claude',{async spawn(_project,spawnContext){onSpawn?.(_project.path);spawnCount++;spawnedTaskIds.push(spawnContext.workbenchTaskId);return{async *dispatch(){yield{kind:'result' as const,sessionId:'second',numTurns:1,durationMs:1}},async close(){}}}},
    {displayName:'Claude',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  const other=makeWorkbenchService({store:secondStore,registry,stateDir,managedWorkspaceRoot:join(area,'Tasks'),ownerChatId:()=>owner,defaultProvider:'claude',matters:makeMatterStore(secondDb)})
  try{
    const material=staged(),request=input({draftId:material.draftId,attachmentIds:material.attachmentIds}),allocate=store.entryRequests.allocate,verify=store.attachments.prepareAcceptance
    let winner:ReturnType<typeof other.createEntry>|undefined
    if(point==='allocation')vi.spyOn(store.entryRequests,'allocate').mockImplementation((...args)=>{const reserved=allocate(...args);winner=other.createEntry(request,{...context,surface:'phone'});return reserved})
    else vi.spyOn(store.attachments,'prepareAcceptance').mockImplementationOnce((...args)=>{winner=other.createEntry(request,{...context,surface:'phone'});return verify(...args)})
    const result=(await service.createEntry(request,context))
    expect(result.receipt).toEqual((await winner!).receipt)
    for(const table of ['workbench_tasks','matters','matter_items','matter_turns'])expect(db.query(`SELECT * FROM ${table}`).all()).toHaveLength(1)
    await expect.poll(()=>other.detail(result.receipt.taskId).task.status).toBe('completed');expect(spawnCount).toBe(1)
  }finally{await other.shutdown();secondDb.close()}
})

it('recovers an accepted commit without activation as interrupted, never creating it again',async()=>{
  const request=input({target:{kind:'project',projectId:service.projects()[0]!.id}}),runId=randomUUID()
  const reservation=store.entryRequests.reserve({ownerKey:'owner',requestId:request.requestId,canonicalRequestHash:canonicalEntryHash(request),target:request.target,
    workspaceId:null,resolvedPath:project,directoryIdentity:'fixture:identity',providerId:'claude',execution:{defaults:'provider',model:null,reasoningEffort:null},materialSnapshot:[]})
  const receipt=store.atomic(()=>{
    const task=store.create({path:project,title:'committed',providerId:'claude',ownerChatId:'owner'}),matters=makeMatterStore(db)
    matters.bind(task.id,'desktop','owner')
    store.execution.accept(task.id,runId,reservation.execution);store.addEvent(task.id,'user',request.text,null,runId)
    return store.entryRequests.accept('owner',request.requestId,{taskId:task.id,matterId:task.id,runId,acceptedAt:Date.now(),resolvedPath:project,directoryIdentity:'fixture:identity'})
  })
  await service.shutdown();db.close();db=openDb({path:join(stateDir,'state.db')});setup('codex')
  const result=(await service.createEntry(request,context))
  expect(result.receipt.taskId).toBe(receipt.taskId);expect(result.receipt.runId).toBe(runId);expect(result.task.status).toBe('interrupted')
  expect(spawnCount).toBe(0);expect(store.list()).toHaveLength(1)
})

it('refuses changed staged bytes before reserving or launching a task',async ()=>{
  const material=staged();writeFileSync(join(stateDir,'workbench-attachments',material.attachment.sha256),'tampered bytes')
  const request=input({draftId:material.draftId,attachmentIds:material.attachmentIds})
  await expect(service.createEntry(request,context)).rejects.toThrow('attachment_changed')
  expect(store.entryRequests.get('owner',request.requestId)).toBeNull();expect(store.list()).toEqual([]);expect(spawnCount).toBe(0)
})

it('requires current capabilities again for a reservation and never substitutes an available provider',async()=>{
  const request=input();db.exec("CREATE TRIGGER entry_fault BEFORE INSERT ON matters BEGIN SELECT RAISE(ABORT,'entry_fault'); END")
  await expect(service.createEntry(request,context)).rejects.toThrow('entry_fault')
  db.exec('DROP TRIGGER entry_fault');await service.shutdown();setup('codex',['codex'])
  await expect(service.createEntry(request,context)).rejects.toThrow('unavailable_provider')
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
  const result=(await service.createEntry(input({text:'',draftId,attachmentIds:[id]}),context));await settle(result.receipt.taskId)
  expect(service.detail(result.receipt.taskId).events.find(e=>e.kind==='user')).toMatchObject({text:'',attachments:[attachment]})
})

it('rejects API-incompatible binary material before reservation, binding or model dispatch',async()=>{
  await service.shutdown();setup('openai',['openai'])
  const draftId=randomUUID(),id=randomUUID()
  const attachment=store.attachments.upload({id,draftId,name:'report.pdf',mime:'application/pdf',base64:Buffer.from('%PDF-1.7 data').toString('base64')},stateDir,{ownerKey:'owner'})
  const request=input({draftId,attachmentIds:[id]})
  await expect(service.createEntry(request,context)).rejects.toThrow('api_task_attachment_unsupported')
  expect(store.entryRequests.get('owner',request.requestId)).toBeNull();expect(spawnCount).toBe(0)
  expect(store.attachments.select([id],undefined,draftId,context)).toEqual([attachment])
})

it.each(['none','expired','missing'] as const)('expires an unaccepted creation reservation before checking %s material',async kind=>{
  const material=kind==='none'?null:staged()
  const request=input(material?{draftId:material.draftId,attachmentIds:material.attachmentIds}:{});db.exec("CREATE TRIGGER entry_fault BEFORE INSERT ON matters BEGIN SELECT RAISE(ABORT,'entry_fault'); END")
  await expect(service.createEntry(request,context)).rejects.toThrow('entry_fault')
  db.exec('DROP TRIGGER entry_fault')
  db.query('UPDATE workbench_entry_requests SET created_at=? WHERE request_id=?').run(Date.now()-8*86400_000,request.requestId)
  if(material&&kind==='expired')db.query('UPDATE workbench_attachments SET created_at=? WHERE id=?').run(Date.now()-8*86400_000,material.attachment.id)
  if(material&&kind==='missing')store.attachments.discard(material.attachment.id,material.draftId,context)
  await expect(service.createEntry(request,context)).rejects.toThrow('entry_expired')
  expect(store.list()).toEqual([]);expect(spawnCount).toBe(0)
})

it('reads entry materials once before acceptance and never under the SQLite write lock',async()=>{
  const material=staged(),request=input({draftId:material.draftId,attachmentIds:material.attachmentIds})
  const other=openDb({path:join(stateDir,'state.db')});other.exec('PRAGMA busy_timeout=0')
  let bytes=0,locked=false
  entryReads.observe=count=>{bytes+=count;try{other.transaction(()=>{}).immediate()}catch{locked=true}}
  let result:Awaited<ReturnType<WorkbenchService['createEntry']>>
  try{result=(await service.createEntry(request,context))}finally{entryReads.observe=null;other.close()}
  expect(bytes).toBe(material.attachment.size)
  expect(locked).toBe(false)
  await settle(result!.receipt.taskId)
})

it.each(['bytes','owner','discard'] as const)('rechecks %s changed after entry material verification before acceptance',async change=>{
  const material=staged(),request=input({draftId:material.draftId,attachmentIds:material.attachmentIds}),atomic=store.atomic
  vi.spyOn(store,'atomic').mockImplementationOnce((operation,immediate)=>{
    if(change==='bytes')writeFileSync(join(stateDir,'workbench-attachments',material.attachment.sha256),'changed! material')
    if(change==='owner')db.query('UPDATE workbench_attachments SET owner_key=? WHERE id=?').run('other',material.attachment.id)
    if(change==='discard')store.attachments.discard(material.attachment.id,material.draftId,context)
    return atomic(operation,immediate)
  })
  await expect(service.createEntry(request,context)).rejects.toThrow()
  expect(store.list()).toHaveLength(0);expect(spawnCount).toBe(0)
})


it('persists the physical managed allocation path before any directory is created',async ()=>{
  const request=input(),reserve=store.entryRequests.reserve
  vi.spyOn(store.entryRequests,'reserve').mockImplementationOnce(value=>{reserve(value);throw Error('reservation_fault')})
  await expect(service.createEntry(request,context)).rejects.toThrow('reservation_fault')
  const reservation=store.entryRequests.get('owner',request.requestId)!
  expect(reservation.resolvedPath).toBe(join(area,'Tasks',reservation.workspaceId!))
  expect(reservation.directoryIdentity).toBeNull()
  expect(existsSync(reservation.resolvedPath!)).toBe(false)
})

it('isolated worktree tasks (2026-10-07): run in parallel on one project, stay out of the project list, commit to their branch, and clean up',async()=>{
  const {execFileSync}=await import('node:child_process'),{readFileSync}=await import('node:fs')
  const g=(...a:string[])=>execFileSync('git',a,{cwd:project,stdio:'pipe'}).toString().trim()
  g('init','-q','-b','main');g('config','user.email','t@t');g('config','user.name','t')
  writeFileSync(join(project,'a.txt'),'one\n');g('add','-A');g('commit','-q','-m','init')
  // 两个独立工作区的任务开在同一个项目:路径不同,谁也不等谁
  const gate=Promise.withResolvers<void>()
  const registry=createProviderRegistry()
  // 会话号按工作区分:两件并行的事共用 'native' 时,一件留着的会话会让另一件续做撞 native_session_busy(Windows 收尾慢时偶发);同一件续做仍是同一个号
  registry.register('claude',{async spawn(p){spawnCount++;const sid=`native:${p.path}`;return{async *dispatch(){await gate.promise;writeFileSync(join(p.path,'out.txt'),'done\n');yield{kind:'text' as const,text:'完成'};yield{kind:'result' as const,sessionId:sid,numTurns:1,durationMs:1}},async close(){}}}},{displayName:'claude',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  await service.shutdown();store=makeWorkbenchStore(db)
  service=makeWorkbenchService({store,registry,stateDir,managedWorkspaceRoot:join(area,'Tasks'),ownerChatId:()=>owner,defaultProvider:'claude',registeredProjects:()=>[{alias:'project',path:project}],matters:makeMatterStore(db),mintSessionToken:()=>'t'})
  const projectId=service.projects()[0]!.id
  // 从分支开始(10-08):分支不在 ⇒ 预约前就拒,不留半截预约
  const before=db.query<{n:number},[]>('SELECT count(*) AS n FROM workbench_entry_requests').get()!.n
  await expect(service.createEntry(input({target:{kind:'project',projectId,isolation:'worktree',base:'nope'}}),context)).rejects.toThrow('worktree_base_missing')
  expect(db.query<{n:number},[]>('SELECT count(*) AS n FROM workbench_entry_requests').get()!.n).toBe(before)
  const one=(await service.createEntry(input({target:{kind:'project',projectId,isolation:'worktree'}}),context))
  const two=(await service.createEntry(input({target:{kind:'project',projectId,isolation:'worktree'}}),context))
  const [a,b]=[service.detail(one.receipt.taskId).task,service.detail(two.receipt.taskId).task]
  // Windows:任务目录是长名真实路径,临时目录可能是 8.3 短名 —— 两边都用 native 真实路径比
  const wtRoot=realpathSync.native(stateDir)
  expect(a.path).not.toBe(b.path);expect(a.path.startsWith(join(wtRoot,'worktrees'))).toBe(true)
  expect(a.waitingFor).toBeNull();expect(b.waitingFor).toBeNull()
  expect(a.worktree).toMatchObject({branch:expect.stringMatching(/^cc\/[a-f0-9]{8}$/),projectPath:project,removed:false})
  expect(readFileSync(join(a.path,'a.txt'),'utf8')).toBe('one\n')
  // 脚本钉在建工作区时的提交(v79)
  expect(store.worktrees.get(one.receipt.taskId)?.scriptSha).toBe(g('rev-parse','HEAD'))
  // 做到条件成立为止(v80):带 until 的,建好时 goal 落库、命令原样;不带的没有 goal
  const three=(await service.createEntry(input({target:{kind:'project',projectId,isolation:'worktree'},until:{command:'bun run test',maxRounds:2}} as never),context))
  expect(store.goals.get(three.receipt.taskId)).toMatchObject({command:'bun run test',maxRounds:2,rounds:0,status:'active'})
  expect(store.goals.get(one.receipt.taskId)).toBeNull()
  gate.resolve();await settle(one.receipt.taskId);await settle(two.receipt.taskId)
  // 不登记成项目
  expect(store.projects().some(p=>p.path.startsWith(join(wtRoot,'worktrees')))).toBe(false);expect(store.ownedProjects('owner').some(p=>p.path.startsWith(join(wtRoot,'worktrees')))).toBe(false)
  expect(service.projects().some(p=>p.path.startsWith(join(wtRoot,'worktrees')))).toBe(false)
  // 提交到分支;项目本身不动
  const commit=(await service.worktreeAction(one.receipt.taskId,'commit'))
  const {mergeHint}=await import('../../adapters/git/worktree-workspaces')
  expect(commit).toMatchObject({committed:true,mergeHint:mergeHint(project,a.worktree!.branch)})
  expect(g('log','-1','--format=%s',a.worktree!.branch)).toBe(a.title)
  expect(existsSync(join(project,'out.txt'))).toBe(false)
  // 合回项目(10-08):快进进 main,任务页记「已合回」
  expect((await service.worktreeAction(one.receipt.taskId,'merge'))).toMatchObject({merged:true,into:'main'})
  expect(readFileSync(join(project,'out.txt'),'utf8').replace(/\r\n/g,'\n')).toBe('done\n');expect(service.detail(one.receipt.taskId).task.worktree?.merged).toBe(true)
  // 再点一次:没有新提交 ⇒ merged:false,但「已合回」不撤;再提交新改动 ⇒「已合回」清掉(10-08 评审)
  expect((await service.worktreeAction(one.receipt.taskId,'merge'))).toMatchObject({merged:false})
  writeFileSync(join(a.path,'more.txt'),'more\n');const again=(await service.worktreeAction(one.receipt.taskId,'commit'))
  expect(service.detail(one.receipt.taskId).task.worktree?.merged).toBe(false)
  // 时间线(会到手机)不带项目路径
  expect(service.detail(one.receipt.taskId).events.some(e=>e.text.includes(project))).toBe(false)
  // 有没提交的改动 ⇒ 不删;提交后删 ⇒ 目录没了、分支还在
  await expect(service.worktreeAction(two.receipt.taskId,'remove')).rejects.toThrow('worktree_dirty')
  ;(await service.worktreeAction(one.receipt.taskId,'remove'))
  expect(existsSync(a.path)).toBe(false);expect(service.detail(one.receipt.taskId).task.worktree?.removed).toBe(true)
  expect(g('rev-parse','--verify',a.worktree!.branch)).toBe(again.sha)
  await expect(service.worktreeAction(one.receipt.taskId,'commit')).rejects.toThrow('worktree_removed')
  // 工作区删了 ⇒ 不再接着做(否则执行者对着不存在的目录跑)
  expect(()=>service.continueTask(one.receipt.taskId,'再改一下')).toThrow('worktree_removed')
  // 重新打开(10-08):从保留的分支检出回原位置,又能接着做
  await expect(service.worktreeAction(two.receipt.taskId,'reopen')).rejects.toThrow('worktree_open')
  expect((await service.worktreeAction(one.receipt.taskId,'reopen'))).toMatchObject({reopened:true})
  expect(service.detail(one.receipt.taskId).task.worktree?.removed).toBe(false);expect(readFileSync(join(a.path,'more.txt'),'utf8')).toBe('more\n')
  service.continueTask(one.receipt.taskId,'再改一下');await settle(one.receipt.taskId)
  ;(await service.worktreeAction(one.receipt.taskId,'commit'));(await service.worktreeAction(one.receipt.taskId,'remove'))
  // 归档时顺手收拾(10-08):有没提交的改动 ⇒ 留着并说一句;提交后再归档 ⇒ 工作区删掉、分支还在
  service.setArchived(two.receipt.taskId,true)
  expect(service.detail(two.receipt.taskId).task.worktree?.removed).toBe(false);expect(existsSync(b.path)).toBe(true)
  await expect.poll(()=>service.detail(two.receipt.taskId).events.at(-1)?.text).toContain('还有没提交的改动，先保留着')
  service.setArchived(two.receipt.taskId,false);(await service.worktreeAction(two.receipt.taskId,'commit'))
  service.setArchived(two.receipt.taskId,true)
  expect(service.detail(two.receipt.taskId).task.worktree?.removed).toBe(true);expect(existsSync(b.path)).toBe(false)
  expect(g('rev-parse','--verify',b.worktree!.branch)).toMatch(/^[0-9a-f]{40}$/)
})

it('until (v80): check fails ⇒ CC continues with the wrapped output; next turn makes it pass ⇒ goal passed; unattended executors refuse until',async()=>{
  const {execFileSync}=await import('node:child_process')
  const g=(...a:string[])=>execFileSync('git',a,{cwd:project,stdio:'pipe'}).toString().trim()
  g('init','-q','-b','main');g('config','user.email','t@t');g('config','user.name','t')
  writeFileSync(join(project,'a.txt'),'one\n');g('add','-A');g('commit','-q','-m','init')
  const prompts:string[]=[]
  const registry=createProviderRegistry()
  registry.register('claude',{async spawn(p){return{async *dispatch(text:string){prompts.push(text);if(prompts.length>=2)writeFileSync(join(p.path,'done.txt'),'ok\n');yield{kind:'text' as const,text:'改好了'};yield{kind:'result' as const,sessionId:'native',numTurns:1,durationMs:1}},async close(){}}}},{displayName:'claude',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  registry.register('agy',{async spawn(){return{async *dispatch(){yield{kind:'result' as const,sessionId:'n',numTurns:1,durationMs:1}},async close(){}}}},{displayName:'agy',canResume:()=>true,workbench:UNATTENDED_CAPABILITIES})
  await service.shutdown();store=makeWorkbenchStore(db)
  service=makeWorkbenchService({store,registry,stateDir,managedWorkspaceRoot:join(area,'Tasks'),ownerChatId:()=>owner,defaultProvider:'claude',registeredProjects:()=>[{alias:'project',path:project}],matters:makeMatterStore(db),mintSessionToken:()=>'t',unattendedAck:{get:()=>1,set:()=>{}}})
  const projectId=service.projects()[0]!.id
  await expect(service.createEntry(input({providerId:'agy',target:{kind:'project',projectId,isolation:'worktree'},until:{command:'true'}} as never),context)).rejects.toThrow('until_unattended_unsupported')
  // Product checks run in native CMD on Windows, which has no POSIX `test` builtin.
  const command=process.platform==='win32'?'if exist done.txt (echo PASSED) else (exit /b 1)':'test -f done.txt && echo PASSED'
  const r=(await service.createEntry(input({target:{kind:'project',projectId,isolation:'worktree'},until:{command,maxRounds:3}} as never),context))
  const id=r.receipt.taskId
  await expect.poll(()=>store.goals.get(id)?.status,{timeout:45_000}).toBe('passed')
  expect(prompts).toHaveLength(2)
  expect(prompts[1]).toContain('第 1/3 轮')
  expect(prompts[1]).toContain('<check_output>')
  expect(prompts[1]).toContain(`\`${command}\``)
  expect(store.goals.get(id)).toMatchObject({rounds:2,lastExit:0})
  expect(service.detail(id).task.until).toEqual({command,maxRounds:3,rounds:2,status:'passed',lastExit:0,stopReason:null})
  const texts=store.events(id).map(e=>e.text)
  expect(texts.some(t=>t.includes('检查没过(第 1/3 轮'))).toBe(true)
  expect(texts.some(t=>t.includes('检查通过(第 2 轮)'))).toBe(true)
  await settle(id)
})

it('an isolated task on a non-git project is refused before anything is reserved; a plain task is not a worktree',async()=>{
  const projectId=service.projects()[0]!.id
  await expect(service.createEntry(input({target:{kind:'project',projectId,isolation:'worktree'}}),context)).rejects.toThrow('worktree_not_git')
  expect(db.query<{n:number},[]>('SELECT count(*) AS n FROM workbench_entry_requests').get()!.n).toBe(0)
  const plain=(await service.createEntry(input({target:{kind:'project',projectId}}),context))
  await expect(service.worktreeAction(plain.receipt.taskId,'commit')).rejects.toThrow('not_worktree')
  await expect(service.createEntry(input({target:{kind:'managed',isolation:'worktree'} as never}),context)).rejects.toThrow('invalid_target')
})

it('WeChat 「任务 新建 <项目> 独立」 (2026-10-07): runs in a worktree, a retry of the same message is the same task, non-git refused',async()=>{
  const {execFileSync}=await import('node:child_process')
  const projectId=service.projects()[0]!.id
  const wechat=(requestId:string)=>({ownerChatId:'owner',accountId:'acc',requestId,commandHash:'a'.repeat(64),projectId,text:'并行整理',isolation:true})
  const rid=randomUUID()
  await expect(service.createWechat(wechat(rid))).rejects.toThrow('worktree_not_git')
  const g=(...a:string[])=>execFileSync('git',a,{cwd:project,stdio:'pipe'}).toString().trim()
  g('init','-q','-b','main');g('config','user.email','t@t');g('config','user.name','t');writeFileSync(join(project,'a.txt'),'x\n');g('add','-A');g('commit','-q','-m','i')
  const first=(await service.createWechat(wechat(rid))),again=(await service.createWechat(wechat(rid)))
  expect(again.taskId).toBe(first.taskId);expect(first.reply).toContain(`任务 ${first.taskId} 合回`)
  const task=service.detail(first.taskId).task
  expect(task.path.startsWith(join(realpathSync.native(stateDir),'worktrees'))).toBe(true)
  expect(task.worktree).toMatchObject({projectPath:project,removed:false})
  expect(store.projects().some(p=>p.path===task.path)).toBe(false)
  expect(store.worktrees.get(first.taskId)?.scriptSha).toBe(g('rev-parse','HEAD'))
  await settle(first.taskId)
})

it('a project added on the desktop is offered for hand-off before it has any task (2026-10-07)',async()=>{
  const extra=join(area,'added');mkdirSync(extra)
  expect(service.projects().some(p=>p.path===realpathSync(extra))).toBe(false)
  service.addProject({path:extra,providerId:'claude'})
  const offered=service.entryOptions(context).projects.find(p=>p.path===realpathSync(extra))
  expect(offered).toMatchObject({providerId:'claude'})
  const done=(await service.createEntry(input({target:{kind:'project',projectId:offered!.id}}),context))
  await settle(done.receipt.taskId)
})

it.skipIf(process.platform==='win32')('worktree scripts (2026-10-20): desktop and WeChat checkouts say 待确认 until the owner approves the exact content; then setup runs once',async()=>{
  const {execFileSync}=await import('node:child_process'),{readFileSync}=await import('node:fs')
  const g=(...a:string[])=>execFileSync('git',a,{cwd:project,stdio:'pipe'}).toString().trim()
  const log=join(area,'setup.log')
  g('init','-q','-b','main');g('config','user.email','t@t');g('config','user.name','t')
  writeFileSync(join(project,'tendhearth.json'),JSON.stringify({scripts:{setup:`echo "$TENDHEARTH_BRANCH" >> ${JSON.stringify(log)}`,run:'sleep 30'}}));g('add','-A');g('commit','-q','-m','init')
  const registry=createProviderRegistry()
  registry.register('claude',{async spawn(){return{async *dispatch(){yield{kind:'result' as const,sessionId:'n',numTurns:1,durationMs:1}},async close(){}}}},{displayName:'claude',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  await service.shutdown();store=makeWorkbenchStore(db)
  service=makeWorkbenchService({store,registry,stateDir,ownerChatId:()=>owner,defaultProvider:'claude',registeredProjects:()=>[{alias:'project',path:project}],matters:makeMatterStore(db),mintSessionToken:()=>'t',scripts:{shell:'/bin/sh',probe:async()=>true}})
  const projectId=service.projects()[0]!.id
  const one=(await service.createEntry(input({target:{kind:'project',projectId,isolation:'worktree'}}),context)).receipt.taskId
  const viaWechat=(await service.createWechat({ownerChatId:'owner',accountId:'acc',requestId:randomUUID(),commandHash:'a'.repeat(64),projectId,text:'并行整理',isolation:true})).taskId
  for(const id of [one,viaWechat])expect(service.detail(id).events.some(e=>e.kind==='system'&&e.text.includes('待确认'))).toBe(true)
  const scripts=service.detail(one).task.worktree?.scripts
  expect(scripts).toMatchObject({configured:true,approved:false,setup:'pending',run:'idle',config:{run:'sleep 30'}})
  // 列表不读脚本(要跑 git)
  expect(service.list().tasks.find(t=>t.id===one)?.worktree?.scripts).toBeUndefined()
  await expect(service.scriptAction(one,'run')).rejects.toThrow('script_approval_required')
  expect(existsSync(log)).toBe(false)
  if(!scripts?.configured)throw new Error('unreachable')
  service.approveScripts(one,scripts.hash)
  await expect.poll(()=>existsSync(log)?readFileSync(log,'utf8').trim():'',{timeout:8000}).toBe(service.detail(one).task.worktree!.branch)
  // 同一个仓库、同一份内容 ⇒ 另一个工作区不用再批
  expect(service.detail(viaWechat).task.worktree?.scripts).toMatchObject({approved:true})
})

it('accepts a not-yet-fetched remote branch, persists its SHA in task details and dispatches a task id',async()=>{
  const {execFileSync}=await import('node:child_process')
  const g=(path:string,...a:string[])=>execFileSync('git',a,{cwd:path,stdio:'pipe'}).toString().trim()
  for(const path of [project,stateDir]){
    g(path,'init','-q','-b','dev');g(path,'config','user.email','t@t');g(path,'config','user.name','t')
    writeFileSync(join(path,'code.txt'),'baseline');g(path,'add','code.txt');g(path,'commit','-qm','baseline')
  }
  g(project,'remote','add','origin',stateDir)
  g(stateDir,'checkout','-qb','fresh')
  writeFileSync(join(stateDir,'fresh.txt'),'fresh code');g(stateDir,'add','fresh.txt');g(stateDir,'commit','-qm','fresh')
  const sha=g(stateDir,'rev-parse','HEAD'),projectId=service.projects()[0]!.id
  const request=input({target:{kind:'project',projectId,isolation:'worktree',base:'origin/fresh'}})
  const accepted=(await service.createEntry(request,context))
  await settle(accepted.task.id)
  const detail=service.detail(accepted.task.id)
  expect(detail.task.worktree).toMatchObject({base:'origin/fresh',baseSha:sha})
  expect(store.worktrees.get(accepted.task.id)?.start).toEqual({base:'origin/fresh',sha,notices:[]})
  expect(detail.events.some(e=>e.kind==='system'&&e.text.includes(`从 origin/fresh @ ${sha.slice(0,7)} 开始`))).toBe(true)
  expect(spawnedTaskIds).toContain(accepted.task.id)
  expect((await service.createEntry(request,context)).task.id).toBe(accepted.task.id)
  expect(g(accepted.task.path,'rev-parse','HEAD')).toBe(sha)
})

it('persists and displays an independent dependency copy notice once across entry retries', async () => {
  const g=(...args:string[])=>execFileSync('git',args,{cwd:project,stdio:'pipe',encoding:'utf8'}).trim()
  g('init','-q','-b','main');g('config','user.email','fixture@localhost');g('config','user.name','Fixture')
  writeFileSync(join(project,'package.json'),'{}');writeFileSync(join(project,'bun.lock'),'lock')
  writeFileSync(join(project,'.gitignore'),'node_modules/\n');g('add','.');g('commit','-qm','dependencies')
  mkdirSync(join(project,'node_modules/library'),{recursive:true});writeFileSync(join(project,'node_modules/library/index.js'),'source')
  vi.spyOn(fsPromises,'copyFile').mockRejectedValue(Object.assign(Error('no clone'),{code:'ENOTSUP'}))
  const request=input({target:{kind:'project',projectId:service.projects()[0]!.id,isolation:'worktree'}})
  const accepted=await service.createEntry(request,context)
  await settle(accepted.task.id)
  expect(store.worktrees.get(accepted.task.id)?.start?.notices).toEqual([DEPENDENCY_COPY_NOTICE])
  expect(readFileSync(join(accepted.task.path,'node_modules/library/index.js'),'utf8')).toBe('source')
  expect((await service.createEntry(request,context)).task.id).toBe(accepted.task.id)
  expect(service.detail(accepted.task.id).events.filter(event=>event.kind==='system'&&event.text.includes(DEPENDENCY_COPY_NOTICE))).toHaveLength(1)
})


it('normal shutdown waits for unaccepted worktree fetch preparation to roll back', async () => {
  const g=(...args:string[])=>execFileSync('git',args,{cwd:project,stdio:'pipe',encoding:'utf8'}).trim()
  g('init','-q','-b','main');g('config','user.email','fixture@localhost');g('config','user.name','Fixture')
  writeFileSync(join(project,'readme'),'base');g('add','.');g('commit','-qm','initial')
  let reached!:()=>void
  const waiting=new Promise<void>(resolve=>{reached=resolve}),server=createServer(()=>reached())
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  g('remote','add','origin',`http://127.0.0.1:${(server.address() as {port:number}).port}/repo`)
  const pending=service.createEntry(input({target:{kind:'project',projectId:service.projects()[0]!.id,isolation:'worktree'}}),context).then(()=>null,error=>error)
  try {
    await Promise.race([waiting,pending.then(error=>{throw Error(`fetch ended before its HTTP request: ${error?.message ?? 'accepted'}`)})])
    await service.shutdown()
    expect(readdirSync(join(project,'.git/objects')).filter(name=>name.startsWith('cc-fetch-'))).toEqual([])
    expect(g('for-each-ref','--format=%(refname)').split('\n').filter(ref=>ref.startsWith('refs/remotes/cc-preparation-'))).toEqual([])
    expect((await pending)?.message).toMatch(/cancelled|stopping/)
    expect(store.list()).toEqual([])
    expect(spawnCount).toBe(0)
  } finally {await pending;server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}
})


it('never publishes executor-installed dependency bytes after confirmed close and task removal', async () => {
  const g=(...args:string[])=>execFileSync('git',args,{cwd:project,stdio:'pipe'})
  g('init','-q');g('config','user.email','test@localhost');g('config','user.name','fixture')
  writeFileSync(join(project,'package.json'),'{}');writeFileSync(join(project,'bun.lock'),'fixture lock');writeFileSync(join(project,'.gitignore'),'node_modules/\n')
  g('add','.');g('commit','-qm','initial')
  let installs=0
  onSpawn=path=>{
    if(existsSync(join(path,'node_modules/tool/index.js')))return
    installs++;mkdirSync(join(path,'node_modules/tool'),{recursive:true});writeFileSync(join(path,'node_modules/tool/index.js'),'installed once')
  }
  const projectId=service.projects()[0]!.id
  const first=await service.createEntry(input({target:{kind:'project',projectId,isolation:'worktree'}}),context)
  await settle(first.receipt.taskId)
  expect(installs).toBe(1)
  await service.worktreeAction(first.receipt.taskId,'remove')
  expect(existsSync(first.task.path)).toBe(false)
  const second=await service.createEntry(input({target:{kind:'project',projectId,isolation:'worktree'}}),context)
  await settle(second.receipt.taskId)
  expect(readFileSync(join(second.task.path,'node_modules/tool/index.js'),'utf8')).toBe('installed once')
  expect(installs).toBe(2)
})

it('shares executor availability with checkup, excluding unacknowledged unattended workers',async()=>{
  await service.shutdown();setup('codex',['codex','unattended'])
  const available=service.entryOptions(context).providers.filter(p=>p.available).map(p=>p.id)
  expect(service.availableExecutors()).toEqual(available)
  expect(available).toEqual(['codex'])
  expect(spawnCount).toBe(0)
})
