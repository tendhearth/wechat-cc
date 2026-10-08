import {afterEach,beforeEach,expect,it} from 'vitest'
import {randomUUID} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {mkdirSync,mkdtempSync,realpathSync,writeFileSync,readFileSync,existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {openDb,type Db} from '../../lib/db'
import {removeTempDir} from '../../lib/test-temp'
import {AsyncQueue} from '../async-queue'
import type {AgentEvent,AgentRuntimeSnapshot,AgentSession,AgentWorkbenchRuntime,SpawnContext} from '../agent-provider'
import {createProviderRegistry} from '../provider-registry'
import {makeMatterStore} from '../matters/store'
import {makeWorkbenchStore} from './store'
import {makeWorkbenchService,type WorkbenchService} from './service'
import {MANAGED_NATIVE_CAPABILITIES} from './executor-capabilities'
let sessions=0
class TurnRuntime {
  sid:string
  instructions:string
  queue=new AsyncQueue<AgentEvent>()
  state:AgentRuntimeSnapshot={retained:true,foreground:'running',backgroundCount:0,input:'send'}
  subscribed=false; submitted=0
  constructor(context:SpawnContext){this.instructions=context.appendInstructions??'';this.sid=context.resumeSessionId??`s${++sessions}`}
  runtime:AgentWorkbenchRuntime={
    events:{[Symbol.asyncIterator]:()=>{this.subscribed=true;return this.queue.iterable()[Symbol.asyncIterator]()}},
    start:()=>{if(!this.subscribed)throw Error('runtime_start_without_consumer');this.queue.push({kind:'init',sessionId:this.sid});this.queue.push({kind:'text',itemId:'t0',text:'做。'})},
    submit:async()=>{this.submitted++;this.state={...this.state,foreground:'running'};this.queue.push({kind:'text',itemId:`t${this.submitted}`,text:'接着做。'})},
    snapshot:()=>this.state,
  }
  session:AgentSession={workbenchRuntime:this.runtime,async *dispatch(){},close:async()=>{this.queue.end()}}
  finishTurn(){this.state={...this.state,foreground:'idle'};this.queue.push({kind:'result',sessionId:this.sid,numTurns:1,durationMs:1})}
}

let area:string,source:string,db:Db,service:WorkbenchService,store:ReturnType<typeof makeWorkbenchStore>,runtimes:TurnRuntime[],setupService:()=>WorkbenchService,groupsAlive:boolean
const git=(...args:string[])=>execFileSync('git',['-C',source,...args],{encoding:'utf8'}).trim()
beforeEach(()=>{
 area=(realpathSync.native??realpathSync)(mkdtempSync(join(tmpdir(),'cc-restore-service-')));source=join(area,'source');mkdirSync(source);mkdirSync(join(area,'state'));mkdirSync(join(area,'home'))
 git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');writeFileSync(join(source,'file.txt'),'original\n');git('add','.');git('commit','-qm','initial')
 db=openDb({path:join(area,'state','state.db')});store=makeWorkbenchStore(db);runtimes=[];groupsAlive=false
 const registry=createProviderRegistry();for(const providerId of ['claude','codex'])registry.register(providerId,{async spawn(_opts,context){const runtime=new TurnRuntime(context);runtimes.push(runtime);return runtime.session}},{displayName:'Claude',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
 setupService=()=>makeWorkbenchService({store,registry,stateDir:join(area,'state'),managedWorkspaceRoot:join(area,'Tasks'),ownerChatId:()=> 'owner',defaultProvider:'claude',registeredProjects:()=>[{alias:'Source',path:source}],matters:makeMatterStore(db),retainedIdleCloseMs:600000,closeTimeoutMs:30,writerWatchMs:20,writerGroupAlive:()=>groupsAlive,isolatedConfiguration:{environment:{HOME:join(area,'home')},systemDirectories:[]}})
 service=setupService()
})
afterEach(async()=>{await service?.shutdown();db?.close();removeTempDir(area)})
async function create(){const r=await service.createEntry({requestId:randomUUID(),text:'Do the work',target:{kind:'project',projectId:service.projects()[0]!.id}},{ownerKey:'owner',surface:'desktop'});await expect.poll(()=>service.detail(r.task.id).events.some(e=>e.kind==='text')).toBe(true);return r.task}
it('captures one full retained writer before spawning, closes only after exit, and restores original bytes',async()=>{
 const task=await create()
 const rows=()=>db.query<{data:string},[]>('SELECT data FROM workbench_restore_runs').all().map(r=>JSON.parse(r.data))
 expect(rows()).toHaveLength(1)
 const restoreId=rows()[0].restoreRunId
 writeFileSync(join(task.path,'file.txt'),'round one\n');runtimes[0]!.finishTurn()
 await expect.poll(()=>service.detail(task.id).task.phase).toBe('replied')
 await expect.poll(()=>service.reviewList(task.id).length).toBe(1)
 expect(rows()[0].status).toBe('active');expect(service.reviewList(task.id)[0]).not.toHaveProperty('restore')
 await service.submitInput(task.id,{runId:service.detail(task.id).runId!,requestId:randomUUID(),text:'again'})
 writeFileSync(join(task.path,'file.txt'),'round two\n');runtimes[0]!.finishTurn()
 await expect.poll(()=>service.detail(task.id).task.phase).toBe('replied')
 await service.cancel(task.id)
 await expect.poll(()=>service.detail(task.id).task.status).toBe('completed')
 expect(rows()).toHaveLength(1);expect(rows()[0]).toMatchObject({restoreRunId:restoreId,status:'closed'})
 const review=service.reviewList(task.id).find(r=>'restore' in r)!
 expect(review).toBeDefined();expect(review.files.find(f=>f.path==='file.txt')?.diff).toContain('-original')
 expect(review.files.find(f=>f.path==='file.txt')?.diff).toContain('+round two')
 const file=review.files.find(f=>f.path==='file.txt')! as typeof review.files[number]&{revert:{changeId:string}}
 const result=await service.revertReviewFile(task.id,{artifactId:review.artifactId,path:file.path,changeId:file.revert.changeId,requestId:randomUUID()} as never)
 expect(result).toMatchObject({state:'reverted'});expect(readFileSync(join(task.path,'file.txt'),'utf8')).toBe('original\n');expect(readFileSync(join(source,'file.txt'),'utf8')).toBe('original\n')
})
const closed=async()=>{const task=await create();writeFileSync(join(task.path,'file.txt'),'changed\n');runtimes.at(-1)!.finishTurn();await expect.poll(()=>service.detail(task.id).task.phase).toBe('replied');await service.cancel(task.id);await expect.poll(()=>service.detail(task.id).task.status).toBe('completed');const review=service.reviewList(task.id).find(r=>r.restore)!;return{task,review,input:{artifactId:review.artifactId,path:'file.txt',changeId:review.files.find(f=>f.path==='file.txt')!.revert!.changeId,requestId:randomUUID()}}}
it('rejects legacy revert with zero effects and replays a receipt after a later writer while putting restore facts in its prompt',async()=>{
 const {task,review,input}=await closed()
 await expect(service.revertReviewFile(task.id,{artifactId:review.artifactId,path:'file.txt'})).rejects.toThrow('review_revert_unavailable')
 expect(readFileSync(join(task.path,'file.txt'),'utf8')).toBe('changed\n')
 const receipt=await service.revertReviewFile(task.id,input)
 service.continueTask(task.id,'continue')
 await expect.poll(()=>runtimes.length).toBe(2)
 writeFileSync(join(task.path,'file.txt'),'later writer\n')
 expect(await service.revertReviewFile(task.id,input)).toEqual(receipt)
 expect(readFileSync(join(task.path,'file.txt'),'utf8')).toBe('later writer\n')
 expect(runtimes[1]!.instructions).toContain('file.txt')
 expect(runtimes[1]!.instructions).toContain(receipt.operationId)
 await expect(service.revertReviewFile(task.id,{...input,path:'other.txt'})).rejects.toThrow('request_conflict')
})
it('exports complete committed/staged/unstaged/untracked changes as an applicable saved patch without touching source/index/refs',async()=>{
 const {task}=await closed(),run=(...args:string[])=>execFileSync('git',['-C',task.path,...args],{encoding:'utf8'})
 run('add','file.txt');run('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','task')
 writeFileSync(join(task.path,'staged.txt'),'staged\n');run('add','staged.txt');writeFileSync(join(task.path,'file.txt'),'working\n');writeFileSync(join(task.path,'new.txt'),'untracked\n')
 const before={index:run('ls-files','--stage'),refs:run('show-ref'),source:git('status','--porcelain')}
 const artifact=await service.exportWorkspace(task.id)
 expect(artifact).not.toHaveProperty('storagePath')
 const bytes=Buffer.from(service.artifact(task.id,artifact.id).contentBase64,'base64')
 expect(bytes.toString()).toContain('new.txt')
 const applied=join(area,'applied');execFileSync('git',['clone','-q','--no-local',source,applied]);execFileSync('git',['-C',applied,'apply','-'],{input:bytes})
 expect(readFileSync(join(applied,'file.txt'),'utf8')).toBe('working\n');expect(readFileSync(join(applied,'new.txt'),'utf8')).toBe('untracked\n');expect(readFileSync(join(applied,'staged.txt'),'utf8')).toBe('staged\n')
 expect({index:run('ls-files','--stage'),refs:run('show-ref'),source:git('status','--porcelain')}).toEqual(before)
})
it('keeps close reservation through async after capture and artifact binding',async()=>{
 const task=await create(),factory=store.gitWorkspaceManager
 const successor=store.create({title:'Successor',path:task.path,providerId:'claude',ownerChatId:'owner',gitWorkspaceId:task.workspace!.id})
 service.continueTask(successor.id,'wait for predecessor')
 let unblock!:()=>void,entered=false
 const wait=new Promise<void>(done=>{unblock=done})
 store.gitWorkspaceManager=options=>{const manager=factory(options);return{...manager,readGitState:async path=>{entered=true;await wait;return manager.readGitState(path)}}}
 writeFileSync(join(task.path,'file.txt'),'changed\n');runtimes[0]!.finishTurn();await expect.poll(()=>service.detail(task.id).task.phase).toBe('replied');await service.cancel(task.id)
 await expect.poll(()=>entered).toBe(true)
 expect(()=>service.continueTask(task.id,'race')).toThrow(/workspace_blocked|workbench_busy/)
 expect(service.reviewList(task.id).some(r=>r.restore)).toBe(false)
 expect(service.detail(successor.id).task.status).toBe('queued');expect(runtimes).toHaveLength(1)
 unblock();await expect.poll(()=>service.detail(task.id).task.status).toBe('completed')
 expect(service.reviewList(task.id).filter(r=>r.restore)).toHaveLength(1)
 await expect.poll(()=>runtimes.length).toBe(2)
 expect(store.restores.allRuns()).toHaveLength(2)
})
it('commits only owned bound workspaces, refuses dirty removal, and persists explicit removal without deleting branch',async()=>{
 const {task}=await closed(),workspace=store.gitWorkspaceForTask(task.id)!
 await expect(Promise.resolve().then(()=>service.worktreeAction(task.id,'remove'))).rejects.toThrow('worktree_dirty')
 expect(await service.worktreeAction(task.id,'commit')).toMatchObject({committed:true,branch:workspace.branch})
 // Public artifacts live in private state. Internal output folders are ignored by the Git manager.
 expect(await service.worktreeAction(task.id,'remove')).toMatchObject({removed:true,branch:workspace.branch})
 expect(service.detail(task.id).task.workspace?.removed).toBe(true)
 expect(git('rev-parse',workspace.branch)).toMatch(/^[a-f0-9]{40}$/)
})

it('keeps empty-group durable writers blocked across restart until explicit administrator confirmation',async()=>{
 const task=await create();writeFileSync(join(task.path,'file.txt'),'uncertain\n')
 runtimes[0]!.session.close=()=>new Promise(()=>{})
 await service.cancel(task.id);await expect.poll(()=>service.detail(task.id).task.error).toBe('writer_not_closed')
 await service.shutdown();service=setupService()
 expect(()=>service.continueTask(task.id,'unsafe')).toThrow('writer_not_closed')
 await expect(service.exportWorkspace(task.id)).rejects.toThrow('writer_not_closed')
 await service.confirmWriterExited(task.id)
 expect(service.reviewList(task.id).filter(r=>r.restore)).toHaveLength(1)
 const run=store.restores.allRuns()[0]!
 expect(run.closeProof?.kind).toBe('administrator');expect(run.status).toBe('closed')
})
it('a late close settles the same durable run exactly once and retained known groups reject false administrator confirmation',async()=>{
 const task=await create();groupsAlive=true;runtimes[0]!.session.processGroups=()=>[23456789]
 let finish!:()=>void;runtimes[0]!.session.close=()=>new Promise(done=>{finish=done})
 writeFileSync(join(task.path,'file.txt'),'late\n');await service.cancel(task.id)
 await expect.poll(()=>service.detail(task.id).task.error).toBe('writer_not_closed')
 await expect(service.confirmWriterExited(task.id)).rejects.toThrow('writer_alive')
 const id=store.restores.allRuns()[0]!.restoreRunId
 groupsAlive=false;finish()
 await expect.poll(()=>service.reviewList(task.id).filter(r=>r.restore).length).toBe(1)
 expect(store.restores.allRuns()).toHaveLength(1);expect(store.restores.run(id)?.status).toBe('closed')
})
it('rolls receipt, path version and task event back together, blocks writers, then recovers the file effect after restart',async()=>{
 const {task,input}=await closed(),beforeSeq=store.version(task.id),workspace=store.gitWorkspaceForTask(task.id)!,beforeVersion=store.restores.pathVersion(workspace.id,'file.txt')
 db.exec("CREATE TRIGGER restore_event_fault BEFORE INSERT ON workbench_events WHEN NEW.kind='system' BEGIN SELECT RAISE(ABORT,'restore_event_fault'); END")
 await expect(service.revertReviewFile(task.id,input)).rejects.toThrow(/restore_event_fault|filesystem_SQLITE_CONSTRAINT|filesystem_ERR_SQLITE_ERROR/)
 expect(readFileSync(join(task.path,'file.txt'),'utf8')).toBe('original\n')
 expect(store.version(task.id)).toBe(beforeSeq);expect(store.restores.pathVersion(workspace.id,'file.txt')).toBe(beforeVersion)
 expect(store.restores.findRequest(workspace.id,input.requestId)?.receipt.state).toBe('needs_recovery')
 expect(()=>service.continueTask(task.id,'unsafe')).toThrow('workspace_blocked')
 await expect(service.exportWorkspace(task.id)).rejects.toThrow('workspace_blocked')
 db.exec('DROP TRIGGER restore_event_fault');await service.shutdown();service=setupService()
 // Recovery has started, but it has not yet crossed its asynchronous Git validation.
 expect(()=>service.continueTask(task.id,'race recovery')).toThrow('workspace_blocked')
 await expect.poll(()=>store.restores.findRequest(workspace.id,input.requestId)?.receipt.state).toBe('reverted')
 expect(store.version(task.id)).toBeGreaterThan(beforeSeq)
 expect(store.restores.pathVersion(workspace.id,'file.txt')).not.toBe(beforeVersion)
 expect(service.detail(task.id).events.filter(e=>e.text.includes('workspace_restore'))).toHaveLength(1)
})
it('preserves quiet-own retained commit compatibility without treating that commit as writer exit',async()=>{
 const task=await create();writeFileSync(join(task.path,'file.txt'),'retained commit\n')
 await expect(Promise.resolve().then(()=>service.worktreeAction(task.id,'commit'))).rejects.toThrow(/writer_not_closed|workbench_busy/)
 runtimes[0]!.finishTurn();await expect.poll(()=>service.detail(task.id).task.phase).toBe('replied')
 expect(await service.worktreeAction(task.id,'commit')).toMatchObject({committed:true})
 expect(store.restores.allRuns()[0]?.status).toBe('active')
 await expect(service.exportWorkspace(task.id)).rejects.toThrow('writer_not_closed')
 await expect(Promise.resolve().then(()=>service.worktreeAction(task.id,'remove'))).rejects.toThrow('writer_not_closed')
})
it('resolves a changed recovery observation by receipt only, and rejects a stale observation',async()=>{
 const {task,input}=await closed(),workspace=store.gitWorkspaceForTask(task.id)!
 db.exec("CREATE TRIGGER restore_event_fault BEFORE INSERT ON workbench_events WHEN NEW.kind='system' BEGIN SELECT RAISE(ABORT,'restore_event_fault'); END")
 await expect(service.revertReviewFile(task.id,input)).rejects.toThrow()
 db.exec('DROP TRIGGER restore_event_fault')
 const operation=store.restores.findRequest(workspace.id,input.requestId)!.receipt
 writeFileSync(join(task.path,'file.txt'),'user choice\n')
 await expect(service.resolveReviewRevert(task.id,{operationId:operation.operationId,observedFingerprint:operation.observedFingerprint!})).rejects.toThrow('observation_changed')
 await service.shutdown();service=setupService()
 await expect.poll(()=>store.restores.findRequest(workspace.id,input.requestId)?.receipt.observedFingerprint).not.toBe(operation.observedFingerprint)
 const observed=store.restores.findRequest(workspace.id,input.requestId)!.receipt
 expect(await service.resolveReviewRevert(task.id,{operationId:observed.operationId,observedFingerprint:observed.observedFingerprint!})).toMatchObject({state:'resolved_keep_current'})
 expect(readFileSync(join(task.path,'file.txt'),'utf8')).toBe('user choice\n')
 expect(service.reviewList(task.id).find(r=>r.restore)!.files.find(f=>f.path==='file.txt')!.revert?.state).toBe('resolved_keep_current')
})
it('restarts an already closed run whose public artifact transaction failed without reopening its execution directory',async()=>{
 const task=await create();writeFileSync(join(task.path,'file.txt'),'unbound close\n')
 db.exec("CREATE TRIGGER restore_artifact_fault BEFORE INSERT ON workbench_artifacts WHEN NEW.name LIKE '会话改动-%' BEGIN SELECT RAISE(ABORT,'restore_artifact_fault'); END")
 await service.cancel(task.id);await expect.poll(()=>service.detail(task.id).task.error).toBe('writer_not_closed')
 expect(store.restores.allRuns()[0]).toMatchObject({status:'closed',artifactId:null})
 await service.shutdown();db.exec('DROP TRIGGER restore_artifact_fault');service=setupService()
 expect(()=>service.continueTask(task.id,'race artifact binding')).toThrow(/workspace_blocked|writer_not_closed/)
 await expect.poll(()=>service.reviewList(task.id).filter(r=>r.restore).length).toBe(1)
 expect(store.restores.allRuns()).toHaveLength(1)
 expect(store.restores.allRuns()[0]!.closeProof?.kind).toBe('session_close')
})
it('keeps previously observed groups when a timed-out provider stops reporting them',async()=>{
 const task=await create();groupsAlive=true;runtimes[0]!.session.processGroups=()=>[34567890]
 runtimes[0]!.session.close=()=>new Promise(()=>{})
 await service.cancel(task.id);await expect.poll(()=>service.detail(task.id).task.error).toBe('writer_not_closed')
 runtimes[0]!.session.processGroups=()=>[]
 await expect(service.confirmWriterExited(task.id)).rejects.toThrow('writer_alive')
 expect(store.restores.allRuns()[0]?.status).toBe('uncertain')
})

it('holds parent and child execution paths out of the entire patch export window',async()=>{
 const {task}=await closed();mkdirSync(join(task.path,'child'))
 const factory=store.gitWorkspaceManager;let unblock!:()=>void,entered=false
 const wait=new Promise<void>(done=>{unblock=done})
 store.gitWorkspaceManager=options=>{const manager=factory(options);return{...manager,exportPatch:async record=>{entered=true;await wait;return manager.exportPatch(record)}}}
 const exporting=service.exportWorkspace(task.id)
 await expect.poll(()=>entered).toBe(true)
 const count=store.list().length
 for(const path of [task.path,join(task.path,'child'),join(task.path,'..')])expect(()=>service.create({path,providerId:'claude',text:'race'})).toThrow(/workspace_blocked|invalid_path|git_workspace_binding_required/)
 expect(store.list()).toHaveLength(count)
 let stopped=false;const stop=service.shutdown().then(()=>{stopped=true})
 await new Promise<void>(done=>setImmediate(done));expect(stopped).toBe(false)
 unblock();await exporting;await stop
 await expect(service.exportWorkspace(task.id)).rejects.toThrow('workbench_stopping')
})
it('recovers known groups gone after restart using the same saved before and records the actual evidence kind',async()=>{
 const task=await create();groupsAlive=true;runtimes[0]!.session.processGroups=()=>[45678901];runtimes[0]!.session.close=()=>new Promise(()=>{})
 writeFileSync(join(task.path,'file.txt'),'groups were writing\n');await service.cancel(task.id)
 await expect.poll(()=>service.detail(task.id).task.error).toBe('writer_not_closed')
 const runId=store.restores.allRuns()[0]!.restoreRunId
 await service.shutdown();groupsAlive=false;service=setupService()
 await expect.poll(()=>store.restores.run(runId)?.status).toBe('closed')
 expect(store.restores.run(runId)?.closeProof).toMatchObject({kind:'groups_gone',groups:[45678901]})
 expect(service.reviewList(task.id).find(r=>r.restore)!.files.find(f=>f.path==='file.txt')!.diff).toContain('-original')
})

it('marks a closed review blocked as soon as a conflicting writer queues, with a bound successor',async()=>{
 const {task,review}=await closed()
 const successor=store.create({title:'Next',path:task.path,providerId:'claude',ownerChatId:'owner',gitWorkspaceId:task.workspace!.id});service.continueTask(successor.id,'another writer')
 const file=service.reviewList(task.id).find(r=>r.artifactId===review.artifactId)!.files.find(f=>f.path==='file.txt')!
 expect(file.revert).toMatchObject({state:'blocked',reason:'writer_not_closed'})
})

it('blocks native handoff acceptance before creating a successor while a restore journal is unresolved',async()=>{
 const {task,input}=await closed()
 const preview=await service.previewHandoff({sourceTaskId:task.id,targetProviderId:'codex',purpose:'review',request:'review',artifacts:[]})
 db.exec("CREATE TRIGGER restore_event_fault BEFORE INSERT ON workbench_events WHEN NEW.kind='system' BEGIN SELECT RAISE(ABORT,'restore_event_fault'); END")
 await expect(service.revertReviewFile(task.id,input)).rejects.toThrow()
 db.exec('DROP TRIGGER restore_event_fault')
 const count=store.list().length
 await expect(service.handoff({token:preview.token})).rejects.toThrow('workspace_blocked')
 expect(store.list()).toHaveLength(count);expect(store.handoffs(task.id)).toEqual([])
})

it('anchors a repository-subdirectory restore to the execution identity and never widens its scope',async()=>{
 const child=join(source,'child');mkdirSync(child);writeFileSync(join(child,'inside.txt'),'inside original\n');git('add','.');git('commit','-qm','child')
 const task=await service.create({requestId:randomUUID(),path:child,providerId:'claude',text:'scoped work'})
 await expect.poll(()=>service.detail(task.id).events.some(e=>e.kind==='text')).toBe(true)
 writeFileSync(join(task.path,'inside.txt'),'inside changed\n');runtimes[0]!.finishTurn();await expect.poll(()=>service.detail(task.id).task.phase).toBe('replied')
 await service.cancel(task.id);await expect.poll(()=>service.detail(task.id).task.status).toBe('completed')
 const review=service.reviewList(task.id).find(r=>r.restore)!,file=review.files.find(f=>f.path==='inside.txt')!
 expect(review.files.some(f=>f.path==='file.txt'||f.path.startsWith('../'))).toBe(false)
 await service.revertReviewFile(task.id,{artifactId:review.artifactId,path:file.path,changeId:file.revert!.changeId,requestId:randomUUID()})
 expect(readFileSync(join(task.path,'inside.txt'),'utf8')).toBe('inside original\n');expect(readFileSync(join(source,'file.txt'),'utf8')).toBe('original\n')
})

it('rejects unbound writers overlapping registered new workspaces before task and entry receipt effects',async()=>{
 const {task}=await closed();mkdirSync(join(task.path,'child'))
 const count=store.list().length,receipts=db.query('SELECT * FROM workbench_entry_requests').all().length
 for(const path of [task.path,join(task.path,'child'),join(task.path,'..')]){
  expect(()=>service.create({path,providerId:'claude',text:'raw'})).toThrow('git_workspace_binding_required')
  await expect(service.create({requestId:randomUUID(),path,providerId:'claude',executionMode:'project',text:'raw keyed'})).rejects.toThrow('git_workspace_binding_required')
 }
 expect(store.list()).toHaveLength(count);expect(db.query('SELECT * FROM workbench_entry_requests').all()).toHaveLength(receipts)
})

it('retains an empty-group legacy parent writer across allocation and two daemon reconstructions',async()=>{
 mkdirSync(join(area,'Tasks'))
 const legacy=service.create({path:join(area,'Tasks'),providerId:'claude',text:'legacy writer before allocation'})
 await expect.poll(()=>runtimes.length).toBe(1)
 const firstService=service
 const entry=await service.createEntry({requestId:randomUUID(),text:'new isolated writer',target:{kind:'project',projectId:service.projects().find(p=>p.path===source)!.id}},{ownerKey:'owner',surface:'desktop'})
 expect(entry.task.status).toBe('queued');expect(store.restores.allRuns()).toHaveLength(0)
 // Reconstruct without gracefully closing the prior provider: this is the restart window.
 service=setupService()
 expect(service.detail(legacy.id).task.error).toBe('writer_not_closed')
 expect(()=>service.continueTask(entry.task.id,'blocked')).toThrow('writer_not_closed')
 await expect(service.exportWorkspace(entry.task.id)).rejects.toThrow('writer_not_closed')
 await service.shutdown();service=setupService()
 expect(()=>service.continueTask(entry.task.id,'still blocked')).toThrow('writer_not_closed')
 await service.confirmWriterExited(legacy.id)
 // Stop the abandoned fixture only after the durable guard has been checked twice.
 await firstService.shutdown()
 const decision=service.prepareContinuation(entry.task.id)
 service.continueTask(entry.task.id,'now safe',decision.mode==='restart_required'?{restartToken:decision.restart.token}:undefined)
 await expect.poll(()=>runtimes.length).toBe(2)
})

it('does not invent an unknown writer for a genuinely closed historical legacy parent',async()=>{
 mkdirSync(join(area,'Tasks'))
 const legacy=service.create({path:join(area,'Tasks'),providerId:'claude',text:'old writer'})
 await expect.poll(()=>runtimes.length).toBe(1);runtimes[0]!.finishTurn();await expect.poll(()=>service.detail(legacy.id).task.phase).toBe('replied')
 await service.cancel(legacy.id);await expect.poll(()=>service.detail(legacy.id).task.status).toBe('completed')
 const task=await create();await service.shutdown();service=setupService()
 expect(service.detail(legacy.id).task.error).not.toBe('writer_not_closed')
 service.continueTask(task.id,'continue safely');await expect.poll(()=>runtimes.length).toBe(3)
})


it('rejects merge for a new managed workspace without changing source, events, or worktree records',async()=>{
 const {task}=await closed(),head=git('rev-parse','HEAD'),events=store.events(task.id).length
 expect(()=>service.worktreeAction(task.id,'merge')).toThrow('invalid_request')
 expect(git('rev-parse','HEAD')).toBe(head);expect(store.events(task.id)).toHaveLength(events);expect(store.worktrees.get(task.id)).toBeNull()
 expect(service.detail(task.id).task.worktree).toMatchObject({merged:false,removed:false})
})

async function pendingCurrent(){
 const {task,input}=await closed(),workspace=store.gitWorkspaceForTask(task.id)!
 db.exec("CREATE TRIGGER resolve_event_fault BEFORE INSERT ON workbench_events WHEN NEW.kind='system' BEGIN SELECT RAISE(ABORT,'resolve_event_fault'); END")
 await expect(service.revertReviewFile(task.id,input)).rejects.toThrow()
 db.exec('DROP TRIGGER resolve_event_fault')
 const operation=store.restores.findRequest(workspace.id,input.requestId)!.receipt
 const resolution={operationId:operation.operationId,observedFingerprint:operation.observedFingerprint!}
 return {task,resolution,operation}
}
async function resolvedCurrent(){
 const {task,resolution}=await pendingCurrent()
 const receipt=await service.resolveReviewRevert(task.id,resolution)
 expect(receipt.state).toBe('resolved_keep_current')
 return {task,resolution,receipt}
}
it('replays the exact resolve receipt after restart and a later writer without file or event effects',async()=>{
 const {task,resolution,receipt}=await resolvedCurrent()
 await service.shutdown();service=setupService()
 service.continueTask(task.id,'later writer');await expect.poll(()=>runtimes.length).toBe(2)
 writeFileSync(join(task.path,'file.txt'),'later writer bytes\n')
 const events=store.events(task.id),operation=store.restores.operation(resolution.operationId),version=store.restores.pathVersion(receipt.workspaceId,receipt.path)
 expect(await service.resolveReviewRevert(task.id,resolution)).toEqual(receipt)
 expect(readFileSync(join(task.path,'file.txt'),'utf8')).toBe('later writer bytes\n')
 expect(store.events(task.id)).toEqual(events);expect(store.restores.operation(resolution.operationId)).toEqual(operation);expect(store.restores.pathVersion(receipt.workspaceId,receipt.path)).toBe(version)
})
it('rejects a changed resolve observation even when the operation is already resolved',async()=>{
 const {task,resolution}=await resolvedCurrent(),operation=store.restores.operation(resolution.operationId),events=store.events(task.id),bytes=readFileSync(join(task.path,'file.txt'))
 await expect(service.resolveReviewRevert(task.id,{...resolution,observedFingerprint:'0'.repeat(64)})).rejects.toThrow('observation_changed')
 expect(store.restores.operation(resolution.operationId)).toEqual(operation);expect(store.events(task.id)).toEqual(events);expect(readFileSync(join(task.path,'file.txt'))).toEqual(bytes)
})


it('fails closed for old resolved receipts without accepted observation proof',async()=>{
 const {task,resolution}=await resolvedCurrent(),op=store.restores.operation(resolution.operationId)!
 delete op.acceptedResolutionFingerprint;store.restores.putOperation(op)
 const events=store.events(task.id),bytes=readFileSync(join(task.path,'file.txt'))
 await expect(service.resolveReviewRevert(task.id,resolution)).rejects.toThrow('operation_not_resolvable')
 expect(store.restores.operation(resolution.operationId)).toEqual(op);expect(store.events(task.id)).toEqual(events);expect(readFileSync(join(task.path,'file.txt'))).toEqual(bytes)
})
it('validates task and manifest association before replaying a resolved receipt',async()=>{
 const {task,resolution,receipt}=await resolvedCurrent(),op=store.restores.operation(resolution.operationId)!
 const other=store.create({title:'Other',path:task.path,providerId:'claude',ownerChatId:'owner',gitWorkspaceId:task.workspace!.id})
 await expect(service.resolveReviewRevert(other.id,resolution)).rejects.toThrow('operation_not_found')
 const run=store.restores.run(op.restoreRunId)!;run.artifactId='another-artifact';store.restores.putRun(run)
 await expect(service.resolveReviewRevert(task.id,resolution)).rejects.toThrow('operation_identity_changed')
 expect(store.restores.operation(resolution.operationId)!.receipt).toEqual(receipt)
})
it('commits accepted resolve proof atomically with receipt, path version, events and sequence',async()=>{
 const {task,resolution,operation}=await pendingCurrent(),saved=store.restores.operation(resolution.operationId)!,events=store.events(task.id),seq=store.version(task.id),version=store.restores.pathVersion(operation.workspaceId,operation.path)
 db.exec("CREATE TRIGGER resolve_commit_fault BEFORE INSERT ON workbench_events WHEN NEW.kind='system' BEGIN SELECT RAISE(ABORT,'resolve_commit_fault'); END")
 await expect(service.resolveReviewRevert(task.id,resolution)).rejects.toThrow()
 expect(store.restores.operation(resolution.operationId)).toEqual(saved);expect(store.events(task.id)).toEqual(events);expect(store.version(task.id)).toBe(seq);expect(store.restores.pathVersion(operation.workspaceId,operation.path)).toBe(version)
 db.exec('DROP TRIGGER resolve_commit_fault')
 await service.resolveReviewRevert(task.id,resolution)
 expect(store.restores.operation(resolution.operationId)).toMatchObject({acceptedResolutionFingerprint:resolution.observedFingerprint,receipt:{state:'resolved_keep_current'}})
 expect(store.restores.pathVersion(operation.workspaceId,operation.path)).not.toBe(version)
})

it('replays a resolved receipt after clean workspace removal using only saved ownership and proof',async()=>{
 const {task,resolution,receipt}=await resolvedCurrent()
 await service.worktreeAction(task.id,'remove')
 const events=store.events(task.id),op=store.restores.operation(resolution.operationId)
 expect(await service.resolveReviewRevert(task.id,resolution)).toEqual(receipt)
 expect(store.events(task.id)).toEqual(events);expect(store.restores.operation(resolution.operationId)).toEqual(op)
})

it('replays an exact revert after explicit clean removal but rejects new effects and changed retry parameters',async()=>{
 const {task,input}=await closed(),receipt=await service.revertReviewFile(task.id,input)
 await service.worktreeAction(task.id,'remove')
 const events=store.events(task.id),op=store.restores.operation(receipt.operationId)
 expect(await service.revertReviewFile(task.id,input)).toEqual(receipt)
 await expect(service.revertReviewFile(task.id,{...input,path:'another.txt'})).rejects.toThrow('request_conflict')
 await expect(service.revertReviewFile(task.id,{...input,requestId:randomUUID()})).rejects.toThrow('worktree_removed')
 expect(store.events(task.id)).toEqual(events);expect(store.restores.operation(receipt.operationId)).toEqual(op)
 expect(service.detail(task.id).task.worktree!.removed).toBe(true)
})

it('archives UUID workspaces without cleanup and retains closed restore bytes and full patch export',async()=>{
 const sourceBefore={head:git('rev-parse','HEAD'),index:readFileSync(join(source,'.git','index')),status:git('status','--porcelain')}
 const {task,review,input}=await closed(),workspace=store.gitWorkspaceForTask(task.id)!
 expect(review.restore?.scope).toBe('closed_session')
 expect(review.files.find(f=>f.path==='file.txt')?.revert?.state).toBe('available')
 const runs=store.restores.allRuns(),snapshot=store.restores.run(runs[0]!.restoreRunId)
 const archived=service.setArchived(task.id,true)
 expect(archived).not.toBeInstanceOf(Promise);expect(archived.archivedAt).not.toBeNull()
 expect(archived.workspace?.removed).not.toBe(true);expect(existsSync(task.path)).toBe(true)
 expect(store.gitWorkspaces.get(workspace.id)).toEqual(workspace)
 expect(store.restores.run(runs[0]!.restoreRunId)).toEqual(snapshot)
 expect(service.reviewList(task.id).find(r=>r.artifactId===review.artifactId)?.files.find(f=>f.path==='file.txt')?.revert?.state).toBe('available')
 expect((await service.revertReviewFile(task.id,input)).state).toBe('reverted')
 expect(readFileSync(join(task.path,'file.txt'),'utf8')).toBe('original\n')
 // A clean UUID copy stays available through restore/unarchive/rearchive too.
 service.setArchived(task.id,false);expect(service.setArchived(task.id,true).workspace?.removed).not.toBe(true)
 writeFileSync(join(task.path,'file.txt'),'export after archive\n');writeFileSync(join(task.path,'new.txt'),'untracked\n')
 const artifact=await service.exportWorkspace(task.id),bytes=Buffer.from(service.artifact(task.id,artifact.id).contentBase64,'base64')
 const applied=join(area,'archive-applied');execFileSync('git',['clone','-q','--no-local',source,applied]);execFileSync('git',['-C',applied,'apply','-'],{input:bytes})
 expect(readFileSync(join(applied,'file.txt'),'utf8')).toBe('export after archive\n');expect(readFileSync(join(applied,'new.txt'),'utf8')).toBe('untracked\n')
 expect({head:git('rev-parse','HEAD'),index:readFileSync(join(source,'.git','index')),status:git('status','--porcelain')}).toEqual(sourceBefore)
 expect(existsSync(task.path)).toBe(true);expect(store.worktrees.get(task.id)).toBeNull()
})

it('rejects reopening a removed UUID workspace without changing binding, closed restore or accepted receipt',async()=>{
 const {task,input}=await closed(),workspace=store.gitWorkspaceForTask(task.id)!
 const reverted=await service.revertReviewFile(task.id,input);await service.worktreeAction(task.id,'remove')
 const receipt=service.entryReceipt(workspace.requestId,{ownerKey:'owner',surface:'desktop'}),runs=store.restores.allRuns()
 const before={workspace:store.gitWorkspaces.get(workspace.id),task:store.get(task.id),events:store.events(task.id),head:git('rev-parse','HEAD'),index:readFileSync(join(source,'.git','index')),refs:git('show-ref')}
 expect(()=>service.worktreeAction(task.id,'reopen' as never)).toThrow('invalid_request')
 const {workbenchRoutes}=await import('../../daemon/internal-api/routes-workbench')
 const routes=workbenchRoutes({workbench:service,resolveAdminChatId:()=> 'owner'} as never)
 expect(await routes['POST /v1/workbench/worktree']!(new URLSearchParams(),{id:task.id,action:'reopen'})).toMatchObject({status:400,body:{error:'invalid_request'}})
 const reply=await service.handleWechat('owner',`任务 ${task.id} 重开工作区`)
 expect(reply).toContain('不支持重开');expect(reply).not.toContain('可以接着做了')
 expect(await service.revertReviewFile(task.id,input)).toEqual(reverted)
 expect(existsSync(task.path)).toBe(false)
 expect({workspace:store.gitWorkspaces.get(workspace.id),task:store.get(task.id),events:store.events(task.id),head:git('rev-parse','HEAD'),index:readFileSync(join(source,'.git','index')),refs:git('show-ref')}).toEqual(before)
 expect(store.restores.allRuns()).toEqual(runs);expect(service.entryReceipt(workspace.requestId,{ownerKey:'owner',surface:'desktop'})).toEqual(receipt)
})
