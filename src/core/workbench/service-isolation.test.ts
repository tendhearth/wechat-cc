import {afterEach,beforeEach,expect,it} from 'vitest'
import {randomUUID} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {mkdirSync,mkdtempSync,realpathSync,writeFileSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,basename} from 'node:path'
import {openDb,type Db} from '../../lib/db'
import {removeTempDir} from '../../lib/test-temp'
import {createProviderRegistry} from '../provider-registry'
import {makeMatterStore} from '../matters/store'
import {makeWorkbenchStore} from './store'
import {makeWorkbenchService,type WorkbenchService} from './service'
import {MANAGED_NATIVE_CAPABILITIES} from './executor-capabilities'
let area:string,source:string,db:Db,service:WorkbenchService,store:ReturnType<typeof makeWorkbenchStore>
let spawned:string[]
const context={ownerKey:'owner',surface:'desktop' as const}
const git=(...args:string[])=>execFileSync('git',['-C',source,...args],{encoding:'utf8'}).trim()
beforeEach(()=>{
 area=(realpathSync.native??realpathSync)(mkdtempSync(join(tmpdir(),'cc-service-isolation-')));source=join(area,'source');mkdirSync(source);mkdirSync(join(area,'state'));mkdirSync(join(area,'home'))
 git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');writeFileSync(join(source,'file.txt'),'original\n');mkdirSync(join(source,'child'));writeFileSync(join(source,'child','child.txt'),'child\n');git('add','.');git('commit','-qm','initial')
 db=openDb({path:join(area,'state','state.db')});store=makeWorkbenchStore(db);spawned=[]
 const registry=createProviderRegistry();for(const providerId of ['claude','codex'])registry.register(providerId,{async spawn(opts){spawned.push(opts.path);return{async *dispatch(){yield{kind:'result' as const,sessionId:randomUUID(),numTurns:1,durationMs:1}},async close(){}}}},{displayName:'Claude',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
 service=makeWorkbenchService({store,registry,stateDir:join(area,'state'),managedWorkspaceRoot:join(area,'Tasks'),ownerChatId:()=> 'owner',defaultProvider:'claude',registeredProjects:()=>[{alias:'Source project',path:source},{alias:'Child',path:join(source,'child')}],matters:makeMatterStore(db),isolatedConfiguration:{environment:{HOME:join(area,'home')},systemDirectories:[]}})
})
afterEach(async()=>{await service?.shutdown();db?.close();removeTempDir(area)})
const request=()=>({requestId:randomUUID(),text:'Do the work',target:{kind:'project' as const,projectId:service.projects().find(p=>p.path===source)!.id}})
it('allocates distinct execution directories and branches while projecting the one source project',async()=>{
 const before={head:git('rev-parse','HEAD'),index:git('ls-files','--stage'),status:git('status','--porcelain')}
 const [a,b]=await Promise.all([service.createEntry(request(),context),service.createEntry(request(),context)])
 expect(a.task.path).not.toBe(source);expect(b.task.path).not.toBe(a.task.path)
 expect(a.task.sourcePath).toBe(source);expect(b.task.sourcePath).toBe(source);expect(a.task.workspace?.branch).not.toBe(b.task.workspace?.branch)
 expect(store.projects().map(p=>p.path)).toEqual([source]);expect(makeMatterStore(db).get(a.receipt.matterId)?.projectPath).toBe(source)
 expect(service.list({q:source}).tasks).toHaveLength(2)
 writeFileSync(join(a.task.path,'file.txt'),'task only\n');expect(readFileSync(join(source,'file.txt'),'utf8')).toBe('original\n')
 expect({head:git('rev-parse','HEAD'),index:git('ls-files','--stage'),status:git('status','--porcelain')}).toEqual(before)
})
it('replays across surfaces and legacy keyed creation without reallocation, rejects changed mode/content',async()=>{
 const input={...request(),title:'Kept title',providerId:'claude'},first=await service.createEntry(input,context)
 expect((await service.createEntry(input,{...context,surface:'phone'})).receipt).toEqual(first.receipt)
 const legacy=await service.create({requestId:input.requestId,title:input.title,path:source,providerId:'claude',text:input.text})
 expect(legacy.id).toBe(first.task.id);expect(legacy.title).toBe(input.title)
 await expect(service.createEntry({...input,text:'Changed'},context)).rejects.toThrow('creation_conflict')
 await expect(service.createEntry({...input,executionMode:'project'},context)).rejects.toThrow('creation_conflict')
 expect(db.query('SELECT * FROM workbench_git_workspaces').all()).toHaveLength(1)
})
it('keeps subdirectory scope and existing synchronous original-directory creation',async()=>{
 const first=await service.createEntry({...request(),target:{kind:'project',projectId:service.projects().find(p=>p.path===join(source,'child'))!.id}},context)
 expect(first.task.sourcePath).toBe(join(source,'child'));expect(basename(first.task.path)).toBe('child')
 const legacy=service.create({path:source,providerId:'claude',text:'legacy'})
 expect(legacy.path).toBe(source);expect(legacy).not.toHaveProperty('sourcePath');expect(legacy).not.toHaveProperty('workspace')
})

it('replays legacy v1 accepted hashes before checking a moved project and does not adopt old unaccepted trees',async()=>{
 const {canonicalEntryHash}=await import('./task-entry'),{renameSync}=await import('node:fs')
 const input={...request(),target:{...request().target,isolation:'worktree' as const}},accepted=await service.createEntry(input,context)
 const row=store.entryRequests.get('owner',input.requestId)!
 const frozen={target:row.target,providerId:row.providerId,execution:row.execution,materialSnapshot:row.materialSnapshot}
 db.query('UPDATE workbench_entry_requests SET canonical_request_hash=?,frozen_json=? WHERE request_id=?').run(canonicalEntryHash(input),JSON.stringify(frozen),input.requestId)
 renameSync(source,source+'-moved')
 expect((await service.createEntry(input,context)).receipt).toEqual(accepted.receipt)
 const old={...input,requestId:randomUUID()}
 store.entryRequests.reserve({ownerKey:'owner',requestId:old.requestId,canonicalRequestHash:canonicalEntryHash(old),target:old.target,workspaceId:randomUUID(),resolvedPath:null,directoryIdentity:null,providerId:'claude',execution:row.execution,materialSnapshot:[]})
 await expect(service.createEntry(old,context)).rejects.toThrow('git_workspace_needs_recovery')
 expect(db.query('SELECT * FROM workbench_git_workspaces').all()).toHaveLength(1)
})
it('keeps raw unregistered paths and legacy titles, and replays keyed requests after a source move',async()=>{
 const {renameSync}=await import('node:fs'),extra=join(area,'unregistered');mkdirSync(extra)
 const input={requestId:randomUUID(),title:'Exact title',path:extra,providerId:'claude',text:'Keep this text',executionMode:'project' as const}
 const task=await service.create(input);expect(task.path).toBe(extra);expect(task.title).toBe(input.title)
 renameSync(extra,extra+'-moved')
 expect((await service.create(input)).id).toBe(task.id)
 await expect(service.create({...input,path:source})).rejects.toThrow('creation_conflict')
})
it('rejects ignored native configuration without acceptance and permits explicit project execution',async()=>{
 writeFileSync(join(source,'.gitignore'),'.claude/settings.local.json\n');git('add','.gitignore');git('commit','-qm','ignore local config')
 mkdirSync(join(source,'.claude'));writeFileSync(join(source,'.claude','settings.local.json'),JSON.stringify({env:{TOKEN:'private-value'}}))
 const input=request()
 await expect(service.createEntry(input,context)).rejects.toThrow('configuration_not_reproducible')
 expect(store.list()).toEqual([]);expect(spawned).toEqual([])
 const reserved=store.entryRequests.get('owner',input.requestId)!
 expect(reserved.resolvedPath).toBeNull();expect(reserved.resolvedMode).toBe('isolated')
 const accepted=await service.createEntry({...input,requestId:randomUUID(),executionMode:'project'},context)
 expect(accepted.task.path).toBe(source);expect(accepted.task).not.toHaveProperty('workspace')
})
it('inherits the same bound directory in review and preserves uncommitted work',async()=>{
 const first=await service.createEntry(request(),context)
 await expect.poll(()=>service.detail(first.task.id).task.status).toBe('completed')
 writeFileSync(join(first.task.path,'file.txt'),'user change\n')
 const preview=await service.previewHandoff({sourceTaskId:first.task.id,targetProviderId:'codex',purpose:'review',request:'review',artifacts:[]})
 const handed=await service.handoff({token:preview.token})
 const handoff={targetTaskId:handed.task.id}
 const next=store.get(handoff.targetTaskId)
 expect(next.gitWorkspaceId).toBe(store.get(first.task.id).gitWorkspaceId);expect(next.path).toBe(first.task.path)
 expect(service.detail(next.id).task.sourcePath).toBe(source)
 expect(makeMatterStore(db).get(next.id)?.projectPath).toBe(source)
 expect(readFileSync(join(next.path,'file.txt'),'utf8')).toBe('user change\n')
 expect(db.query('SELECT * FROM workbench_git_workspaces').all()).toHaveLength(1)
})
it('rejects a provider switch with unreproducible configuration before accepting a handoff',async()=>{
 const first=await service.createEntry(request(),context)
 await expect.poll(()=>service.detail(first.task.id).task.status).toBe('completed')
 const preview=await service.previewHandoff({sourceTaskId:first.task.id,targetProviderId:'codex',purpose:'review',request:'review',artifacts:[]})
 mkdirSync(join(source,'.codex'));writeFileSync(join(source,'.codex','config.toml'),'model = "private-model"\n')
 const before=store.get(first.task.id)
 await expect(service.handoff({token:preview.token})).rejects.toThrow('configuration_not_reproducible')
 expect(store.list()).toHaveLength(1);expect(store.handoffs(first.task.id)).toEqual([]);expect(store.get(first.task.id)).toEqual(before);expect(spawned).toHaveLength(1)
 rmSync(join(source,'.codex'),{recursive:true})
 const accepted=await service.handoff({token:preview.token})
 mkdirSync(join(source,'.codex'));writeFileSync(join(source,'.codex','config.toml'),'model = "changed-model"\n')
 expect((await service.handoff({token:preview.token})).task.id).toBe(accepted.task.id)
})
it('retains Wechat allocation and frozen choices after acceptance rollback without a matter store',async()=>{
 await service.shutdown()
 const registry=createProviderRegistry();for(const id of ['claude','codex'])registry.register(id,{async spawn(p){spawned.push(p.path);return{async *dispatch(){yield{kind:'result' as const,sessionId:'native',numTurns:1,durationMs:1}},async close(){}}}},{displayName:id,canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
 const setup=(defaultProvider:string)=>makeWorkbenchService({store,registry,stateDir:join(area,'state'),managedWorkspaceRoot:join(area,'Tasks'),ownerChatId:()=> 'owner',defaultProvider,registeredProjects:()=>[{alias:'project',path:source}],isolatedConfiguration:{environment:{HOME:join(area,'home')},systemDirectories:[]}})
 service=setup('claude')
 const input={ownerChatId:'owner',accountId:'account',commandHash:'c'.repeat(64),requestId:randomUUID(),projectId:service.projects()[0]!.id,text:'work'}
 db.exec("CREATE TRIGGER acceptance_fault BEFORE INSERT ON workbench_creation_receipts BEGIN SELECT RAISE(ABORT,'acceptance_fault'); END")
 await expect(service.createWechat(input)).rejects.toThrow('acceptance_fault')
 const reservation=store.entryRequests.get('owner',input.requestId)!,workspace=store.gitWorkspaces.get(reservation.workspaceId!)!
 expect(store.list()).toEqual([]);expect(spawned).toEqual([]);expect(store.creationReceipts.get(input.requestId)).toBeNull()
 db.exec('DROP TRIGGER acceptance_fault');await service.shutdown();service=setup('codex')
 writeFileSync(join(source,'file.txt'),'source changed\n')
 await expect(service.createWechat(input)).rejects.toThrow('git_workspace_changed')
 expect(store.list()).toEqual([]);expect(db.query('SELECT * FROM workbench_git_workspaces').all()).toHaveLength(1)
 writeFileSync(join(source,'file.txt'),'original\n')
 const accepted=await service.createWechat(input)
 expect(accepted.providerId).toBe('claude');expect(accepted.path).toBe(workspace.executionPath)
 expect(store.gitWorkspaces.get(workspace.id)).toMatchObject({branch:workspace.branch,baseCommit:workspace.baseCommit,sourcePath:source})
 await expect.poll(()=>service.detail(accepted.taskId).task.status).toBe('completed');expect(spawned).toHaveLength(1)
 db.query('UPDATE workbench_entry_requests SET created_at=0 WHERE request_id=?').run(input.requestId)
 expect(await service.createWechat(input)).toEqual(accepted)
 await expect(service.createWechat({...input,executionMode:'project'})).rejects.toThrow('creation_conflict')
 expect(db.query('SELECT * FROM workbench_git_workspaces').all()).toHaveLength(1)
 expect(service.entryReceipt(input.requestId,context)).toBeNull()
})
it('preserves workspace metadata and request identity through actual desktop and phone route serializers',async()=>{
 const {workbenchRoutes}=await import('../../daemon/internal-api/routes-workbench')
 const {mobileWorkbenchRoute}=await import('../../daemon/mobile-workbench')
 const {EntryResult}=await import('@wechat-cc/protocol')
 const routes=workbenchRoutes({workbench:service,resolveAdminChatId:()=> 'owner'} as never)
 const input={...request(),providerId:'claude',title:'HTTP title'}
 const response=await routes['POST /v1/workbench/create']!(new URLSearchParams(),{requestId:input.requestId,path:source,providerId:input.providerId,title:input.title,text:input.text})
 expect(response.status).toBe(202);const task=(response.body as {task:{id:string}}).task
 const url=new URL('http://phone.test/m/api/matter/create')
 const phone=await mobileWorkbenchRoute(undefined,url,new Request(url,{method:'POST',body:JSON.stringify(input)}),{
  entryOptions:()=>service.entryOptions({...context,surface:'phone'}),entryReceipt:id=>service.entryReceipt(id,{...context,surface:'phone'}),createEntry:value=>service.createEntry(value,{...context,surface:'phone'}),
 })
 expect(phone!.status).toBe(202)
 const decoded=EntryResult.parse(await phone!.json());expect(decoded.task.id).toBe(task.id);expect(decoded.task.sourcePath).toBe(source);expect(decoded.task.workspace?.mode).toBe('isolated');expect(decoded.task.worktree?.projectPath).toBe(source)
 const rejected=await routes['POST /v1/workbench/create']!(new URLSearchParams(),{path:source,providerId:'claude',text:'request',executionMode:'auto'})
 expect(rejected).toMatchObject({status:400,body:{error:'invalid_request_id'}})
})
it('keeps the execution directory, workspace binding and source matter when quota hands off',async()=>{
 await service.shutdown()
 const registry=createProviderRegistry()
 registry.register('claude',{async spawn(){return{async *dispatch(){yield{kind:'error' as const,message:"You've hit your usage limit. Try again at 10:00"}},async close(){}}}},{displayName:'Claude',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
 registry.register('codex',{async spawn(){return{async *dispatch(){yield{kind:'result' as const,sessionId:'native',numTurns:1,durationMs:1}},async close(){}}}},{displayName:'Codex',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
 service=makeWorkbenchService({store,registry,stateDir:join(area,'state'),managedWorkspaceRoot:join(area,'Tasks'),ownerChatId:()=> 'owner',defaultProvider:'claude',registeredProjects:()=>[{alias:'project',path:source}],matters:makeMatterStore(db),isolatedConfiguration:{environment:{HOME:join(area,'home')},systemDirectories:[]}})
 const first=await service.createEntry(request(),context)
 await expect.poll(()=>service.detail(first.task.id).task.status).toBe('failed')
 writeFileSync(join(first.task.path,'file.txt'),'retained work\n')
 mkdirSync(join(source,'.codex'));writeFileSync(join(source,'.codex','config.toml'),'model = "private-model"\n')
 const input={requestId:randomUUID(),providerId:'codex'},before=store.get(first.task.id)
 await expect(Promise.resolve().then(()=>service.handOff(first.task.id,input))).rejects.toThrow('configuration_not_reproducible')
 expect(store.list()).toHaveLength(1);expect(store.get(first.task.id)).toEqual(before);expect(store.creationReceipts.get(input.requestId)).toBeNull()
 rmSync(join(source,'.codex'),{recursive:true})
 const [handed,replayed]=await Promise.all([service.handOff(first.task.id,input),service.handOff(first.task.id,input)]),next=store.get(handed.taskId)
 expect(replayed.taskId).toBe(handed.taskId);expect(store.list()).toHaveLength(2)
 mkdirSync(join(source,'.codex'));writeFileSync(join(source,'.codex','config.toml'),'model = "changed-model"\n')
 expect(await service.handOff(first.task.id,input)).toEqual({taskId:handed.taskId,created:false})
 expect(next.gitWorkspaceId).toBe(store.get(first.task.id).gitWorkspaceId);expect(next.path).toBe(first.task.path)
 expect(makeMatterStore(db).get(next.id)?.projectPath).toBe(source)
 expect(readFileSync(join(next.path,'file.txt'),'utf8')).toBe('retained work\n')
 expect(db.query('SELECT * FROM workbench_git_workspaces').all()).toHaveLength(1)
})
it('accepts one concurrent Git request through independent SQLite connections',async()=>{
 const secondDb=openDb({path:join(area,'state','state.db')}),otherStore=makeWorkbenchStore(secondDb),registry=createProviderRegistry()
 registry.register('claude',{async spawn(p){spawned.push(p.path);return{async *dispatch(){yield{kind:'result' as const,sessionId:'second',numTurns:1,durationMs:1}},async close(){}}}},{displayName:'Claude',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
 const other=makeWorkbenchService({store:otherStore,registry,stateDir:join(area,'state'),managedWorkspaceRoot:join(area,'Tasks'),ownerChatId:()=> 'owner',defaultProvider:'claude',registeredProjects:()=>[{alias:'project',path:source}],matters:makeMatterStore(secondDb),isolatedConfiguration:{environment:{HOME:join(area,'home')},systemDirectories:[]}})
 try{
  const input=request(),[a,b]=await Promise.all([service.createEntry(input,context),other.createEntry(input,{...context,surface:'phone'})])
  expect(a.receipt).toEqual(b.receipt)
  expect(store.list()).toHaveLength(1);expect(db.query('SELECT * FROM workbench_git_workspaces').all()).toHaveLength(1)
  await expect.poll(()=>service.detail(a.task.id).task.status).toBe('completed');expect(spawned).toHaveLength(1)
 }finally{await other.shutdown();secondDb.close()}
})
