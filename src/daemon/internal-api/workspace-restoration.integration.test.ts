import {afterEach,beforeEach,describe,expect,it,type TestContext} from 'vitest'
import {randomUUID} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {lstatSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {openDb,type Db} from '../../lib/db'
import {removeTempDir} from '../../lib/test-temp'
import {AsyncQueue} from '../../core/async-queue'
import type {AgentEvent,AgentRuntimeSnapshot,AgentSession,AgentWorkbenchRuntime} from '../../core/agent-provider'
import {createProviderRegistry} from '../../core/provider-registry'
import {makeMatterStore} from '../../core/matters/store'
import {makeWorkbenchStore} from '../../core/workbench/store'
import {makeWorkbenchService,type WorkbenchService} from '../../core/workbench/service'
import {MANAGED_NATIVE_CAPABILITIES} from '../../core/workbench/executor-capabilities'
import {createInternalApi,type InternalApi} from './index'

// Only the external executor is substituted. Git, SQLite, stores, service,
// route dispatch, token enforcement, and the TCP listener are the real ones.
class RetainedWriter {
  queue=new AsyncQueue<AgentEvent>()
  state:AgentRuntimeSnapshot={retained:true,foreground:'running',backgroundCount:0,input:'send'}
  subscribed=false
  closed=false
  constructor(readonly path:string,readonly providerId:string,readonly sid:string){}
  runtime:AgentWorkbenchRuntime={
    events:{[Symbol.asyncIterator]:()=>{this.subscribed=true;return this.queue.iterable()[Symbol.asyncIterator]()}},
    start:()=>{
      if(!this.subscribed)throw Error('writer_started_without_event_consumer')
      if(this.providerId==='claude')writeFileSync(join(this.path,'file.txt'),'round one\r\n')
      this.queue.push({kind:'init',sessionId:this.sid})
      this.queue.push({kind:'text',itemId:'first',text:'First turn'})
    },
    submit:async()=>{
      this.state={...this.state,foreground:'running'}
      writeFileSync(join(this.path,'file.txt'),'round two\r\n')
      this.queue.push({kind:'text',itemId:'second',text:'Second turn'})
    },
    snapshot:()=>this.state,
  }
  session:AgentSession={workbenchRuntime:this.runtime,async *dispatch(){},close:async()=>{this.closed=true;this.queue.end()}}
  finishTurn(){this.state={...this.state,foreground:'idle'};this.queue.push({kind:'result',sessionId:this.sid,numTurns:1,durationMs:1})}
}

const original=Buffer.from('\ufefforiginal\r\n','utf8')
let area:string,source:string,stateDir:string,db:Db,store:ReturnType<typeof makeWorkbenchStore>,service:WorkbenchService,api:InternalApi
let base:string,operator:string,trusted:string,writers:RetainedWriter[]
const git=(path:string,...args:string[])=>execFileSync('git',['--no-optional-locks','-C',path,...args],{encoding:'utf8'})
const sourceState=()=>({bytes:readFileSync(join(source,'file.txt')),head:git(source,'rev-parse','HEAD'),branch:git(source,'symbolic-ref','HEAD'),index:readFileSync(join(source,'.git','index')),status:git(source,'status','--porcelain')})
type Phase=(name:string)=>void
function restorationPhases({signal,onTestFailed,onTestFinished}:TestContext):Phase{
  // The overall deadline stays unchanged. Record the last unfinished boundary
  // before cleanup, so a timeout distinguishes HTTP stop, SQLite reopen, and
  // journal recovery instead of reporting only the end of the source file.
  const started=performance.now(),timeline:Array<{phase:string;elapsedMs:number}>=[]
  let reported=false
  const phase:Phase=name=>{if(!signal.aborted&&timeline.length<64)timeline.push({phase:name,elapsedMs:Math.round(performance.now()-started)})}
  const report=()=>{if(!reported){reported=true;console.error('[http-restoration] unfinished phase',JSON.stringify({elapsedMs:Math.round(performance.now()-started),timeline}))}}
  signal.addEventListener('abort',report,{once:true})
  onTestFailed(report);onTestFinished(()=>signal.removeEventListener('abort',report))
  return phase
}
async function open(phase:Phase=()=>{}){
  phase('open disk SQLite')
  db=openDb({path:join(stateDir,'state.db')});store=makeWorkbenchStore(db)
  const registry=createProviderRegistry()
  for(const providerId of ['claude','codex'])registry.register(providerId,{async spawn(opts,context){
    const writer=new RetainedWriter(opts.path,providerId,context.resumeSessionId??randomUUID());writers.push(writer);return writer.session
  }},{displayName:providerId,canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  phase('construct service and start durable recovery')
  service=makeWorkbenchService({store,registry,stateDir,managedWorkspaceRoot:join(area,'Tasks'),ownerChatId:()=> 'owner',defaultProvider:'claude',registeredProjects:()=>[{alias:'Fixture',path:source}],matters:makeMatterStore(db),retainedIdleCloseMs:600000,isolatedConfiguration:{environment:{HOME:join(area,'home')},systemDirectories:[]}})
  api=createInternalApi({stateDir,daemonPid:1,workbench:service,resolveAdminChatId:()=> 'owner'} as never)
  phase('start authenticated HTTP listener')
  const started=await api.start();base=`http://127.0.0.1:${started.port}`
  operator=readFileSync(started.operatorTokenFilePath,'utf8').trim();trusted=readFileSync(started.tokenFilePath,'utf8').trim()
}
async function close(phase:Phase=()=>{}){
  phase('stop authenticated HTTP listener');await api?.stop({unlinkToken:true})
  phase('drain service writers and recovery');await service?.shutdown()
  phase('close disk SQLite');db?.close()
}
async function restart(phase:Phase=()=>{}){await close(phase);await open(phase)}
const post=(route:string,body:unknown,token=operator)=>fetch(base+'/v1/workbench/'+route,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)})
async function get(route:string){const response=await fetch(base+'/v1/workbench/'+route,{headers:{authorization:`Bearer ${operator}`}});expect(response.status).toBe(200);return response.json()}
async function accepted(route:string,body:unknown,status:number){const response=await post(route,body);expect(response.status).toBe(status);return response.json()}
const detail=(id:string)=>get('task?id='+id)
const reviews=async(id:string)=>(await get('review?id='+id)).reviews as Array<{artifactId:string;restore?:{scope:string};files:Array<{path:string;diff?:string;revert?:{changeId:string;state:string}}> }>
async function input(){const options=await get('entry-options');return{requestId:randomUUID(),text:'Change fixture',providerId:'claude',target:{kind:'project',projectId:options.projects.find((p:{path:string})=>p.path===source).id}}}
async function create(){const result=await accepted('create-entry',await input(),202);await expect.poll(async()=>(await detail(result.task.id)).events.some((e:{kind:string})=>e.kind==='text')).toBe(true);return result.task}
async function closedTask(){const task=await create();writers.at(-1)!.finishTurn();await expect.poll(async()=>(await detail(task.id)).task.phase).toBe('replied');await end(task.id);return task}
async function end(id:string){
  await accepted('cancel',{id},202)
  await expect.poll(async()=>(await reviews(id)).filter(r=>r.restore?.scope==='closed_session').length).toBe(1)
  await expect.poll(async()=>(await detail(id)).task.status).toBe('completed')
}
async function restoreInput(id:string){const review=(await reviews(id)).find(r=>r.restore?.scope==='closed_session')!;const file=review.files.find(f=>f.path==='file.txt')!;expect(file.revert?.state).toBe('available');return{id,artifactId:review.artifactId,path:file.path,changeId:file.revert!.changeId,requestId:randomUUID()}}

beforeEach(async()=>{
  area=(realpathSync.native??realpathSync)(mkdtempSync(join(tmpdir(),'cc-http-restoration-')));source=join(area,'source');stateDir=join(area,'state');writers=[]
  for(const path of [source,stateDir,join(area,'home')])mkdirSync(path)
  git(source,'init','-q');git(source,'config','user.name','Fixture');git(source,'config','user.email','fixture@example.invalid');git(source,'config','core.autocrlf','false')
  writeFileSync(join(source,'file.txt'),original);git(source,'add','.');git(source,'commit','-qm','Initial fixture')
  await open()
})
afterEach(async()=>{for(const writer of writers)writer.queue.end();await close();removeTempDir(area)})

describe('workspace isolation and restoration through actual authenticated HTTP',()=>{
  it('runs two retained writers in distinct copies and replays creation without reallocating or spawning',async()=>{
    const before=sourceState(),aInput=await input(),bInput=await input()
    const [a,b]=await Promise.all([accepted('create-entry',aInput,202),accepted('create-entry',bInput,202)])
    await expect.poll(()=>writers.length).toBe(2)
    expect(a.task.path).not.toBe(source);expect(b.task.path).not.toBe(a.task.path)
    expect(a.task.workspace.branch).not.toBe(b.task.workspace.branch)
    for(const task of [a.task,b.task]){
      expect(task.sourcePath).toBe(source)
      await expect.poll(()=>readFileSync(join(task.path,'file.txt'),'utf8')).toBe('round one\r\n')
      expect((await detail(task.id)).task.status).toBe('running')
    }
    const replay=await accepted('create-entry',aInput,202)
    expect(replay.receipt).toEqual(a.receipt);expect(replay.task.id).toBe(a.task.id)
    expect(db.query('SELECT * FROM workbench_git_workspaces').all()).toHaveLength(2);expect(writers).toHaveLength(2)
    expect(sourceState()).toEqual(before)
    for(const writer of writers)writer.finishTurn()
    await Promise.all([a.task,b.task].map(async task=>{await expect.poll(async()=>(await detail(task.id)).task.phase).toBe('replied');await end(task.id)}))
    expect(writers.every(w=>w.closed)).toBe(true);expect(sourceState()).toEqual(before)
  })

  it('requires real close, restores exact session bytes, and replays after reopening SQLite',async context=>{
    const phase=restorationPhases(context)
    phase('create first retained writer')
    const before=sourceState(),task=await create(),writer=writers[0]!
    phase('finish first retained turn and capture review')
    writer.finishTurn();await expect.poll(async()=>(await detail(task.id)).task.phase).toBe('replied')
    await expect.poll(async()=>(await reviews(task.id)).length).toBe(1)
    const first=(await reviews(task.id))[0]!
    expect(first.restore).toBeUndefined()
    expect((await post('review-revert',{id:task.id,artifactId:first.artifactId,path:'file.txt',changeId:randomUUID(),requestId:randomUUID()})).status).toBe(409)
    expect((await post('workspace-export',{id:task.id})).status).toBe(409)
    expect(writer.closed).toBe(false);expect(readFileSync(join(task.path,'file.txt'),'utf8')).toBe('round one\r\n')
    const runId=(await detail(task.id)).runId
    phase('submit and finish second retained turn')
    await accepted('input',{id:task.id,runId,requestId:randomUUID(),text:'Second turn'},200)
    await expect.poll(()=>readFileSync(join(task.path,'file.txt'),'utf8')).toBe('round two\r\n')
    writer.finishTurn();await expect.poll(async()=>(await detail(task.id)).task.phase).toBe('replied')
    phase('close real writer and capture closed-session review')
    await end(task.id);expect(writer.closed).toBe(true)
    const review=(await reviews(task.id)).find(r=>r.restore)!
    expect(review.files.find(f=>f.path==='file.txt')!.diff).toContain('original')
    expect(review.files.find(f=>f.path==='file.txt')!.diff).toContain('+round two')
    const request=await restoreInput(task.id)
    phase('restore exact session bytes through authenticated HTTP')
    expect((await post('review-revert',request,trusted)).status).toBe(403)
    const {operation}=await accepted('review-revert',request,200)
    expect(operation.state).toBe('reverted');expect(readFileSync(join(task.path,'file.txt'))).toEqual(original)
    await restart(phase)
    phase('replay stored receipt without reapplying later edit')
    // A later user edit makes an accidental reapplication observable.
    writeFileSync(join(task.path,'file.txt'),'keep later edit\n')
    const laterStat=lstatSync(join(task.path,'file.txt'))
    expect((await accepted('review-revert',request,200)).operation).toEqual(operation)
    expect(lstatSync(join(task.path,'file.txt'))).toMatchObject({ino:laterStat.ino,mtimeMs:laterStat.mtimeMs})
    expect(readFileSync(join(task.path,'file.txt'),'utf8')).toBe('keep later edit\n')
    expect(db.query('SELECT * FROM workbench_restore_operations').all()).toHaveLength(1)
    phase('verify replay leaves source Git invariants unchanged')
    expect(sourceState()).toEqual(before)
  })

  it('persists a failed receipt and writer barrier across SQLite reopen, then recovers the same journal operation',async context=>{
    const phase=restorationPhases(context),before=sourceState()
    phase('create and close fault-recovery writer')
    const faultTask=await closedTask(),faultRequest=await restoreInput(faultTask.id)
    expect(writers[0]!.closed).toBe(true)
    phase('inject receipt transaction failure and verify durable barriers')
    db.exec("CREATE TRIGGER http_restore_receipt_fault BEFORE INSERT ON workbench_events WHEN NEW.kind='system' BEGIN SELECT RAISE(ABORT,'http_restore_receipt_fault'); END")
    const failed=await post('review-revert',faultRequest)
    expect(failed.status).toBe(503);expect(await failed.json()).toEqual({error:'restore_storage_unavailable'})
    expect(readFileSync(join(faultTask.path,'file.txt'))).toEqual(original)
    const pending=store.restores.findRequest(faultTask.workspace.id,faultRequest.requestId)!.receipt
    expect(pending.state).toBe('needs_recovery')
    expect((await post('continue',{id:faultTask.id,text:'Must not start'})).status).toBe(409)
    expect((await post('workspace-export',{id:faultTask.id})).status).toBe(409)
    const count=writers.length
    // Leave the fault installed across a genuine disk-database close/open.
    await restart(phase)
    phase('verify blocked writer after reopening with persistent fault')
    expect((await post('continue',{id:faultTask.id,text:'Still blocked'})).status).toBe(409)
    expect(writers).toHaveLength(count)
    db.exec('DROP TRIGGER http_restore_receipt_fault')
    await restart(phase)
    phase('wait for durable journal recovery')
    await expect.poll(()=>store.restores.findRequest(faultTask.workspace.id,faultRequest.requestId)?.receipt.state).toBe('reverted')
    const recovered=await accepted('review-revert',faultRequest,200)
    expect(recovered.operation).toMatchObject({operationId:pending.operationId,state:'reverted'});expect(readFileSync(join(faultTask.path,'file.txt'))).toEqual(original)
    expect(db.query('SELECT * FROM workbench_restore_operations').all()).toHaveLength(1)
    phase('verify recovered bytes and source Git invariants')
    expect(sourceState()).toEqual(before)
  })

  it('hands review to the same copy and exports an applicable complete patch without changing real Git state',async()=>{
    const before=sourceState(),task=await closedTask()
    writeFileSync(join(task.path,'file.txt'),'user work before review\n')
    const preview=await accepted('handoff-preview',{sourceTaskId:task.id,targetProviderId:'codex',purpose:'review',request:'review',artifacts:[]},200)
    const handed=await accepted('handoff',{token:preview.token},202),next=handed.task
    await expect.poll(()=>writers.length).toBe(2)
    expect(next.path).toBe(task.path);expect(next.workspace.id).toBe(task.workspace.id);expect(next.sourcePath).toBe(source)
    expect(readFileSync(join(next.path,'file.txt'),'utf8')).toBe('user work before review\n')
    expect(db.query('SELECT * FROM workbench_git_workspaces').all()).toHaveLength(1)
    writers[1]!.finishTurn();await expect.poll(async()=>(await detail(next.id)).task.phase).toBe('replied');await end(next.id)
    writeFileSync(join(task.path,'committed.txt'),'committed\n');git(task.path,'add','committed.txt');git(task.path,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Task commit')
    writeFileSync(join(task.path,'staged.txt'),'staged\n');git(task.path,'add','staged.txt')
    writeFileSync(join(task.path,'file.txt'),'unstaged final\n');writeFileSync(join(task.path,'untracked.txt'),'untracked\n')
    mkdirSync(join(task.path,'.cc-workbench-inputs'),{recursive:true});writeFileSync(join(task.path,'.cc-workbench-inputs','private.txt'),'private fixture\n')
    const gitState=()=>({head:git(task.path,'rev-parse','HEAD'),index:readFileSync(join(git(task.path,'rev-parse','--absolute-git-dir').trim(),'index')),refs:git(task.path,'show-ref')})
    const executionBefore=gitState(),{artifact}=await accepted('workspace-export',{id:next.id},200)
    expect((await post('workspace-export',{id:next.id},trusted)).status).toBe(403)
    const downloaded=await get(`artifact?id=${next.id}&artifactId=${artifact.id}`),bytes=Buffer.from(downloaded.contentBase64,'base64')
    expect(bytes.toString()).not.toContain('.cc-workbench');expect(bytes.toString()).not.toContain('private fixture')
    // This clone is a byte-assertion fixture. Its local config must be set
    // before checkout; source config does not propagate through git clone.
    const applied=join(area,'applied');execFileSync('git',['clone','-q','--no-local','--config','core.autocrlf=false',source,applied]);execFileSync('git',['-C',applied,'apply','-'],{input:bytes})
    for(const [path,want] of [['file.txt','unstaged final\n'],['committed.txt','committed\n'],['staged.txt','staged\n'],['untracked.txt','untracked\n']])expect(readFileSync(join(applied,path!),'utf8')).toBe(want)
    expect(readdirSync(applied).sort()).toEqual(['.git','committed.txt','file.txt','staged.txt','untracked.txt'])
    expect(gitState()).toEqual(executionBefore);expect(sourceState()).toEqual(before)
  })
})
