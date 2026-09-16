import {afterEach,beforeEach,expect,it} from 'vitest'
import {mkdtempSync,mkdirSync,realpathSync,rmSync,writeFileSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {execFileSync} from 'node:child_process'
import {openDb,type Db} from '../../lib/db'
import {AsyncQueue} from '../async-queue'
import {createProviderRegistry} from '../provider-registry'
import type {AgentEvent,AgentRuntimeSnapshot,AgentSession,AgentWorkbenchRuntime} from '../agent-provider'
import {makeWorkbenchStore} from './store'
import {makeWorkbenchService,type WorkbenchService} from './service'
import {MANAGED_NATIVE_CAPABILITIES} from './executor-capabilities'
import {readArtifactSnapshot} from './artifacts'

/**
 * 评审 #9(2026-09-16):答复即释放租约之后,同文件夹的 B 进来改文件;A 之后结算时对
 * 整个项目做 git 差异 —— B 的改动被记成 A 的「代码变更」。租约原本就是差异边界。
 * 要求:差异快照在**释放租约时**截取,续接**申请租约时**重新取基线。
 */
const result:AgentEvent={kind:'result',sessionId:'s',numTurns:1,durationMs:1}
class TurnRuntime {
  queue=new AsyncQueue<AgentEvent>()
  state:AgentRuntimeSnapshot={retained:true,foreground:'running',backgroundCount:0,input:'send'}
  subscribed=false; submitted=0
  runtime:AgentWorkbenchRuntime={
    events:{[Symbol.asyncIterator]:()=>{this.subscribed=true;return this.queue.iterable()[Symbol.asyncIterator]()}},
    start:()=>{if(!this.subscribed)throw Error('runtime_start_without_consumer');this.queue.push({kind:'init',sessionId:'s'});this.queue.push({kind:'text',itemId:'t0',text:'做。'})},
    submit:async()=>{this.submitted++;this.state={...this.state,foreground:'running'};this.queue.push({kind:'text',itemId:`t${this.submitted}`,text:'接着做。'})},
    snapshot:()=>this.state,
  }
  session:AgentSession={workbenchRuntime:this.runtime,async *dispatch(){},close:async()=>{this.queue.end()}}
  finishTurn(){this.state={...this.state,foreground:'idle'};this.queue.push(result)}
}
let area:string,project:string,db:Db,service:WorkbenchService,store:ReturnType<typeof makeWorkbenchStore>,runtimes:TurnRuntime[]
const git=(...args:string[])=>execFileSync('git',args,{cwd:project,stdio:'pipe',env:{...process.env,GIT_AUTHOR_NAME:'t',GIT_AUTHOR_EMAIL:'t@t',GIT_COMMITTER_NAME:'t',GIT_COMMITTER_EMAIL:'t@t'}})
beforeEach(()=>{
  area=realpathSync(mkdtempSync(join(tmpdir(),'cc-review-boundary-')));project=join(area,'project');mkdirSync(project)
  git('init','-q');writeFileSync(join(project,'README.md'),'base\n');git('add','.');git('commit','-q','-m','base')
  db=openDb({path:join(area,'state.db')});runtimes=[]
  const registry=createProviderRegistry()
  registry.register('claude',{async spawn(){const r=new TurnRuntime();runtimes.push(r);return r.session}},{displayName:'Claude',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  store=makeWorkbenchStore(db);service=makeWorkbenchService({store,registry,stateDir:area,ownerChatId:()=>null})
})
afterEach(async()=>{await service?.shutdown();db.close();rmSync(area,{recursive:true,force:true})})
const settled=async(id:string)=>{await expect.poll(()=>service.detail(id).task.status).not.toMatch(/^(running|queued|cancelling)$/)}
const reviews=(id:string)=>service.detail(id).artifacts.filter(a=>a.name.startsWith('代码变更')).sort((x,y)=>x.name.localeCompare(y.name)).map(a=>({name:a.name,files:(JSON.parse(readArtifactSnapshot(store.artifact(id,a.id).storagePath,area,a.sha256).toString()) as {files:Array<{path:string;kind:string}>}).files.filter(f=>f.kind!=='not_reviewed').map(f=>f.path).sort()}))

it('A 答复释放租约后 B 改的文件不会记到 A 的代码变更里;A 续接时重新取基线',async()=>{
  const a=service.create({path:project,providerId:'claude',text:'A'})
  await expect.poll(()=>service.detail(a.id).events.some(e=>e.kind==='text')).toBe(true)
  writeFileSync(join(project,'a.txt'),'by A\n')
  runtimes[0]!.finishTurn()
  await expect.poll(()=>service.detail(a.id).task.phase).toBe('replied')
  // B 同文件夹进来(证明租约已释放),改了 b.txt
  const b=service.create({path:project,providerId:'claude',text:'B'})
  await expect.poll(()=>service.detail(b.id).task.status).toBe('running')
  await expect.poll(()=>service.detail(b.id).events.some(e=>e.kind==='text')).toBe(true)
  writeFileSync(join(project,'b.txt'),'by B\n')
  runtimes[1]!.finishTurn()
  await expect.poll(()=>service.detail(b.id).task.phase).toBe('replied')
  // A 的第一轮差异:只有 a.txt
  await expect.poll(()=>reviews(a.id).length).toBe(1)
  expect(reviews(a.id)[0]!.files).toEqual(['a.txt'])
  // A 续接:申请租约时重新取基线;A 这一轮改 a2.txt
  await service.submitInput(a.id,{runId:service.detail(a.id).runId!,requestId:'11111111-1111-4111-8111-111111111111',text:'再来'})
  await expect.poll(()=>runtimes[0]!.submitted).toBe(1)
  writeFileSync(join(project,'a2.txt'),'by A again\n')
  runtimes[0]!.finishTurn()
  await expect.poll(()=>reviews(a.id).length).toBe(2)
  // 两份快照各只含自己那一轮的文件(不按列表顺序断言)
  expect(reviews(a.id).map(r=>r.files).sort((x,y)=>x[0]!.localeCompare(y[0]!))).toEqual([['a.txt'],['a2.txt']])
  // 关掉 A:不再重复生成第三份
  await service.cancel(a.id);await settled(a.id)
  expect(reviews(a.id)).toHaveLength(2)
  // B 的差异只有 b.txt
  await service.cancel(b.id);await settled(b.id)
  expect(reviews(b.id).map(r=>r.files)).toEqual([['b.txt']])
})

it('续接时存储写入失败,刚申请的租约要放回去,别把文件夹锁死(评审:acquireTurnLease 泄漏)',async()=>{
  const a=service.create({path:project,providerId:'claude',text:'A'})
  await expect.poll(()=>service.detail(a.id).events.some(e=>e.kind==='text')).toBe(true)
  runtimes[0]!.finishTurn()
  await expect.poll(()=>service.detail(a.id).task.phase).toBe('replied')
  // 「答复」是从运行时快照派生的,租约要等差异快照截完才真正放开;拿一个同文件夹的 B
  // 跑起来再取消,确认 A 此刻确实不持有租约 —— 这样下面的续接一定会走申请那条路。
  const probe=service.create({path:project,providerId:'claude',text:'probe'})
  await expect.poll(()=>service.detail(probe.id).task.status).toBe('running')
  await service.cancel(probe.id)
  await settled(probe.id)
  const run=service.detail(a.id).runId!
  const add=store.liveInputs.add
  store.liveInputs.add=()=>{throw Error('disk_full')}
  try{await expect(service.submitInput(a.id,{runId:run,requestId:'22222222-2222-4222-8222-222222222222',text:'再来'})).rejects.toThrow(/^disk_full$/)}
  finally{store.liveInputs.add=add}
  // A 仍是答复态、没在写 —— 同文件夹的 B 必须能直接开跑,而不是排在一把没人持有的锁后面。
  const b=service.create({path:project,providerId:'claude',text:'B'})
  await expect.poll(()=>service.detail(b.id).task.status).toBe('running')
})
