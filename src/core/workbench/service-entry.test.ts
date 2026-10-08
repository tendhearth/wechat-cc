import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {randomUUID} from 'node:crypto'
import {existsSync,mkdirSync,mkdtempSync,realpathSync,readFileSync,renameSync,writeFileSync,unlinkSync} from 'node:fs'
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

const entryReads=vi.hoisted(()=>({observe:null as null|((count:number)=>void)}))
vi.mock('node:fs',async importOriginal=>{
  const fs=await importOriginal<typeof import('node:fs')>()
  return{...fs,readSync:(...args:unknown[])=>{const count=Reflect.apply(fs.readSync,fs,args) as number;entryReads.observe?.(count);return count}}
})

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
  service=makeWorkbenchService({store,registry,stateDir,managedWorkspaceRoot:join(area,'Tasks'),isolatedConfiguration:{environment:{HOME:join(area,'home')},systemDirectories:[]},ownerChatId:()=>owner,defaultProvider,
    registeredProjects:()=>[{alias:'project',path:project}],matters:makeMatterStore(db),changes:hub,mintSessionToken:()=>{mintCount++;return'test-token'}})
}
beforeEach(()=>{
  area=realpathSync(mkdtempSync(join(tmpdir(),'cc-entry-service-')));stateDir=join(area,'state');project=join(area,'project');mkdirSync(stateDir);mkdirSync(project);mkdirSync(join(area,'home'))
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
  const request=input(),first=(await service.createEntry(request,context))
  expect((await service.createEntry(request,{...context,surface:'phone'})).receipt).toEqual(first.receipt)
  expect(first.task.workspaceKind).toBe('managed');expect(first.receipt.taskId).toBe(first.receipt.matterId)
  expect(service.entryReceipt(request.requestId,context)?.receipt).toEqual(first.receipt)
  const counts=['workbench_tasks','matters','workbench_events','workbench_run_execution'].map(table=>db.query<{n:number},[]>(`SELECT count(*) AS n FROM ${table}`).get()!.n)
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
  const material=staged(),request=input({draftId:material.draftId,attachmentIds:material.attachmentIds}),published=vi.spyOn(hub,'publish')
  if(point==='matter')db.exec("CREATE TRIGGER entry_fault BEFORE INSERT ON matters BEGIN SELECT RAISE(ABORT,'entry_fault'); END")
  if(point==='binding')db.exec("CREATE TRIGGER entry_fault BEFORE INSERT ON matter_bindings BEGIN SELECT RAISE(ABORT,'entry_fault'); END")
  if(point==='receipt')db.exec("CREATE TRIGGER entry_fault BEFORE UPDATE OF phase ON workbench_entry_requests BEGIN SELECT RAISE(ABORT,'entry_fault'); END")
  if(point==='outer-commit'){
    const atomic=store.atomic;let depth=0
    vi.spyOn(store,'atomic').mockImplementation(operation=>{depth++;try{return atomic(()=>{const result=operation();if(depth===1)throw Error('entry_fault');return result})}finally{depth--}})
  }
  await expect(service.createEntry(request,context)).rejects.toThrow('entry_fault')
  await Promise.resolve();expect(spawnCount).toBe(0);expect(mintCount).toBe(0);expect(published).not.toHaveBeenCalled()
  for(const table of ['workbench_tasks','matters','workbench_events','workbench_run_execution','matter_bindings'])expect(db.query(`SELECT * FROM ${table}`).all()).toEqual([])
  expect(store.attachments.select(material.attachmentIds,undefined,material.draftId,{ownerKey:'owner'})).toEqual([material.attachment])
  expect(store.entryRequests.get('owner',request.requestId)?.phase).toBe('reserved')
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
  expect(makeMatterStore(db).get(matter.originMatterId!)?.ownerChatId).toBe('owner');expect(matter.originMessageId).toBeNull()
  await expect(service.createEntry(input({target:{kind:'project',projectId:'p-'+'a'.repeat(20)}}),context)).rejects.toThrow('project_stale')
  owner='new-owner';expect(()=>service.entryReceipt(request.requestId,context)).toThrow('invalid_entry_owner')
  expect(service.entryReceipt(request.requestId,{ownerKey:'new-owner',surface:'phone'})).toBeNull()
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
  registry.register('claude',{async spawn(){spawnCount++;return{async *dispatch(){yield{kind:'result' as const,sessionId:'second',numTurns:1,durationMs:1}},async close(){}}}},
    {displayName:'Claude',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  const other=makeWorkbenchService({store:secondStore,registry,stateDir,managedWorkspaceRoot:join(area,'Tasks'),isolatedConfiguration:{environment:{HOME:join(area,'home')},systemDirectories:[]},ownerChatId:()=>owner,defaultProvider:'claude',matters:makeMatterStore(secondDb)})
  try{
    const material=staged(),request=input({draftId:material.draftId,attachmentIds:material.attachmentIds}),allocate=store.entryRequests.allocate,verify=store.attachments.prepareAcceptance
    let winner:ReturnType<typeof other.createEntry>|undefined
    if(point==='allocation')vi.spyOn(store.entryRequests,'allocate').mockImplementation((...args)=>{const reserved=allocate(...args);winner=other.createEntry(request,{...context,surface:'phone'});return reserved})
    else vi.spyOn(store.attachments,'prepareAcceptance').mockImplementationOnce((...args)=>{winner=other.createEntry(request,{...context,surface:'phone'});return verify(...args)})
    const result=(await service.createEntry(request,context))
    expect(result.receipt).toEqual((await winner!).receipt)
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
  registry.register('claude',{async spawn(p){spawnCount++;return{async *dispatch(){await gate.promise;writeFileSync(join(p.path,'out.txt'),'done\n');yield{kind:'text' as const,text:'完成'};yield{kind:'result' as const,sessionId:'native',numTurns:1,durationMs:1}},async close(){}}}},{displayName:'claude',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  await service.shutdown();store=makeWorkbenchStore(db)
  service=makeWorkbenchService({store,registry,stateDir,managedWorkspaceRoot:join(area,'Tasks'),isolatedConfiguration:{environment:{HOME:join(area,'home')},systemDirectories:[]},ownerChatId:()=>owner,defaultProvider:'claude',registeredProjects:()=>[{alias:'project',path:project}],matters:makeMatterStore(db),changes:makeTaskChangeHub(),mintSessionToken:()=>'t'})
  const projectId=service.projects()[0]!.id
  const one=(await service.createEntry(input({target:{kind:'project',projectId,isolation:'worktree'}}),context))
  const two=(await service.createEntry(input({target:{kind:'project',projectId,isolation:'worktree'}}),context))
  const [a,b]=[service.detail(one.receipt.taskId).task,service.detail(two.receipt.taskId).task]
  // Windows:任务目录是长名真实路径,临时目录可能是 8.3 短名 —— 两边都用 native 真实路径比
  const wtRoot=realpathSync.native(join(area,'Tasks'))
  expect(a.path).not.toBe(b.path);expect(a.path.startsWith(join(wtRoot,'GitWorkspaces'))).toBe(true)
  expect(a.waitingFor).toBeNull();expect(b.waitingFor).toBeNull()
  expect(a.worktree).toMatchObject({branch:expect.stringMatching(/^codex\/cc-task-/),projectPath:project,removed:false})
  expect(readFileSync(join(a.path,'a.txt'),'utf8')).toBe('one\n')
  gate.resolve();await settle(one.receipt.taskId);await settle(two.receipt.taskId)
  // 不登记成项目
  expect(store.projects().some(p=>p.path.startsWith(join(wtRoot,'GitWorkspaces')))).toBe(false);expect(store.ownedProjects('owner').some(p=>p.path.startsWith(join(wtRoot,'GitWorkspaces')))).toBe(false)
  expect(service.projects().some(p=>p.path.startsWith(join(wtRoot,'GitWorkspaces')))).toBe(false)
  expect(existsSync(join(project,'out.txt'))).toBe(false)

})

it('an isolated task on a non-git project is refused before anything is reserved; a plain task is not a worktree',async()=>{
  const projectId=service.projects()[0]!.id
  await expect(service.createEntry(input({target:{kind:'project',projectId,isolation:'worktree'}}),context)).rejects.toThrow('git_workspace_source_unsupported')
  expect(db.query<{n:number},[]>('SELECT count(*) AS n FROM workbench_entry_requests').get()!.n).toBe(0)
  const plain=(await service.createEntry(input({target:{kind:'project',projectId}}),context))
  expect(()=>service.worktreeAction(plain.receipt.taskId,'commit')).toThrow('not_worktree')
  await expect(service.createEntry(input({target:{kind:'managed',isolation:'worktree'} as never}),context)).rejects.toThrow('invalid_target')
})

it('WeChat 「任务 新建 <项目> 独立」 (2026-10-07): runs in a worktree, a retry of the same message is the same task, non-git refused',async()=>{
  const {execFileSync}=await import('node:child_process')
  const projectId=service.projects()[0]!.id
  const wechat=(requestId:string)=>({ownerChatId:'owner',accountId:'acc',requestId,commandHash:'a'.repeat(64),projectId,text:'并行整理',isolation:true})
  const rid=randomUUID()
  await expect(service.createWechat(wechat(rid))).rejects.toThrow('git_workspace_source_unsupported')
  const g=(...a:string[])=>execFileSync('git',a,{cwd:project,stdio:'pipe'}).toString().trim()
  g('init','-q','-b','main');g('config','user.email','t@t');g('config','user.name','t');writeFileSync(join(project,'a.txt'),'x\n');g('add','-A');g('commit','-q','-m','i')
  const first=(await service.createWechat(wechat(rid))),again=(await service.createWechat(wechat(rid)))
  expect(again.taskId).toBe(first.taskId)
  const task=service.detail(first.taskId).task
  expect(task.path.startsWith(join(realpathSync.native(join(area,'Tasks')),'GitWorkspaces'))).toBe(true)
  expect(task.worktree).toMatchObject({projectPath:project,removed:false})
  expect(store.projects().some(p=>p.path===task.path)).toBe(false)
  expect(first.reply).toContain(`在独立分支 ${task.worktree!.branch}`)
  expect(first.reply).toContain(`任务 ${task.id} 提交`)
  expect(first.reply).not.toContain(`任务 ${task.id} 合回`)
  expect(again.reply).toBe(first.reply)
  await settle(first.taskId)
  await expect.poll(()=>service.detail(task.id).task.canArchive).toBe(true)
  writeFileSync(join(task.path,'phone.txt'),'copy change\n')
  const committed=await service.handleWechat('owner',`任务 ${task.id} 提交`)
  expect(committed).toContain(`已提交到分支 ${task.worktree!.branch}`)
  expect(committed).not.toContain(`任务 ${task.id} 合回`)
  const unsupported=await service.handleWechat('owner',`任务 ${task.id} 合回`)
  expect(unsupported).toContain('不支持直接合回')
  expect(unsupported).not.toContain('已合进')
  expect(existsSync(join(project,'phone.txt'))).toBe(false)
  writeFileSync(join(task.path,'dirty.txt'),'new\n')
  const refused=await service.handleWechat('owner',`任务 ${task.id} 删除工作区`)
  expect(refused).toContain('没提交的改动');expect(refused).not.toContain('已删除')
  expect(existsSync(task.path)).toBe(true)
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

it('preserves explicit commit/remove for historical v74 worktrees',async()=>{
  const {execFileSync}=await import('node:child_process')
  const {ensureWorktree,planWorktree}=await import('./worktree-workspaces')
  const g=(...args:string[])=>execFileSync('git',args,{cwd:project,stdio:'pipe'}).toString().trim()
  g('init','-q','-b','main');g('config','user.email','t@t');g('config','user.name','t');writeFileSync(join(project,'a.txt'),'one\n');g('add','-A');g('commit','-qm','init')
  const make=async()=>{
    const plan=planWorktree({stateDir,projectId:service.projects()[0]!.id,projectPath:project,repoRoot:project,id:randomUUID().replaceAll('-','').slice(0,8)})
    const path=ensureWorktree(plan),task=service.create({path,providerId:'claude',text:'historical',registerProject:false})
    store.worktrees.record({taskId:task.id,projectPath:project,repoRoot:project,root:plan.root,branch:plan.branch});await settle(task.id)
    writeFileSync(join(path,'out.txt'),'done\n');return task
  }
  const first=await make(),second=await make(),a=service.detail(first.id).task,b=service.detail(second.id).task,one={receipt:{taskId:first.id}},two={receipt:{taskId:second.id}}
  // 提交到分支;项目本身不动
  const commit=await service.worktreeAction(one.receipt.taskId,'commit')
  const {mergeHint}=await import('./worktree-workspaces')
  expect(commit).toMatchObject({committed:true,mergeHint:mergeHint(project,a.worktree!.branch)})
  expect(g('log','-1','--format=%s',a.worktree!.branch)).toBe(a.title)
  expect(existsSync(join(project,'out.txt'))).toBe(false)
  // 合回项目(10-08):快进进 main,任务页记「已合回」
  expect(service.worktreeAction(one.receipt.taskId,'merge')).toMatchObject({merged:true,into:'main'})
  expect(readFileSync(join(project,'out.txt'),'utf8').replace(/\r\n/g,'\n')).toBe('done\n');expect(service.detail(one.receipt.taskId).task.worktree?.merged).toBe(true)
  // 有没提交的改动 ⇒ 不删;提交后删 ⇒ 目录没了、分支还在
  expect(()=>service.worktreeAction(two.receipt.taskId,'remove')).toThrow('worktree_dirty')
  service.worktreeAction(one.receipt.taskId,'remove')
  expect(existsSync(a.path)).toBe(false);expect(service.detail(one.receipt.taskId).task.worktree?.removed).toBe(true)
  expect(g('rev-parse','--verify',a.worktree!.branch)).toBe(commit.sha)
  expect(()=>service.worktreeAction(one.receipt.taskId,'commit')).toThrow('worktree_removed')
  // Archive must commit successfully before touching the filesystem or emitting cleanup events.
  service.worktreeAction(second.id,'commit')
  const events=service.detail(second.id).events.length
  db.exec("CREATE TRIGGER archive_fault BEFORE UPDATE OF archived_at ON workbench_tasks BEGIN SELECT RAISE(ABORT,'archive_fault'); END")
  expect(()=>service.setArchived(second.id,true)).toThrow('archive_fault')
  expect(service.detail(second.id).task.archivedAt).toBeNull();expect(service.detail(second.id).events).toHaveLength(events)
  expect(existsSync(b.path)).toBe(true);expect(store.worktrees.get(second.id)?.removedAt).toBeNull()
  db.exec('DROP TRIGGER archive_fault');writeFileSync(join(b.path,'out.txt'),'dirty after committed archive fixture\n')
  // 归档时顺手收拾(10-08):有没提交的改动 ⇒ 留着并说一句;提交后再归档 ⇒ 工作区删掉、分支还在
  service.setArchived(two.receipt.taskId,true)
  expect(service.detail(two.receipt.taskId).task.worktree?.removed).toBe(false);expect(existsSync(b.path)).toBe(true)
  expect(service.detail(two.receipt.taskId).events.at(-1)?.text).toContain('还有没提交的改动，先保留着')
  service.setArchived(two.receipt.taskId,false);service.worktreeAction(two.receipt.taskId,'commit')
  const archived=service.setArchived(two.receipt.taskId,true)
  expect(archived).not.toBeInstanceOf(Promise);expect(archived.archivedAt).toEqual(expect.any(Number))
  expect(archived.worktree?.removed).toBe(true)
  expect(service.detail(two.receipt.taskId).task.worktree?.removed).toBe(true);expect(existsSync(b.path)).toBe(false)
  expect(g('rev-parse','--verify',b.worktree!.branch)).toMatch(/^[0-9a-f]{40}$/)
})
