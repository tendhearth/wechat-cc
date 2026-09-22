import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {mkdtempSync,mkdirSync,realpathSync,writeFileSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {execFileSync} from 'node:child_process'
import {openDb,type Db} from '../../lib/db'
import {AsyncQueue} from '../async-queue'
import {createProviderRegistry} from '../provider-registry'
import type {AgentEvent,AgentRuntimeSnapshot,AgentSession,AgentWorkbenchRuntime,SpawnContext} from '../agent-provider'
import {makeWorkbenchStore} from './store'
import {makeWorkbenchService,type WorkbenchService} from './service'
import {MANAGED_NATIVE_CAPABILITIES} from './executor-capabilities'
import {readArtifactSnapshot} from './artifacts'
import {removeTempDir} from '../../lib/test-temp'

/**
 * 评审 #9(2026-09-16):A 的「代码变更」快照不能把别人改的文件记到它头上。差异边界 =
 * **回合**边界:回合安静时截一份,续接时重新取基线。
 *
 * 2026-09-21:文件夹的占用改成「派发到会话关闭为止」,所以 A 空闲期间 B 根本进不来 ——
 * 跨任务的串味在构造上不可能了。仍然要测的是同一条 run 里**两个回合各自一份**快照,以及
 * 「续接时写库失败不能把文件夹永久锁住」(原来那条靠 acquireTurnLease 把租约还回去;现在靠
 * 把空闲自动收工的计时重新起上)。
 */
let sessions=0
class TurnRuntime {
  sid:string
  queue=new AsyncQueue<AgentEvent>()
  state:AgentRuntimeSnapshot={retained:true,foreground:'running',backgroundCount:0,input:'send'}
  subscribed=false; submitted=0
  constructor(context:SpawnContext){this.sid=context.resumeSessionId??`s${++sessions}`}
  runtime:AgentWorkbenchRuntime={
    events:{[Symbol.asyncIterator]:()=>{this.subscribed=true;return this.queue.iterable()[Symbol.asyncIterator]()}},
    start:()=>{if(!this.subscribed)throw Error('runtime_start_without_consumer');this.queue.push({kind:'init',sessionId:this.sid});this.queue.push({kind:'text',itemId:'t0',text:'做。'})},
    submit:async()=>{this.submitted++;this.state={...this.state,foreground:'running'};this.queue.push({kind:'text',itemId:`t${this.submitted}`,text:'接着做。'})},
    snapshot:()=>this.state,
  }
  session:AgentSession={workbenchRuntime:this.runtime,async *dispatch(){},close:async()=>{this.queue.end()}}
  finishTurn(){this.state={...this.state,foreground:'idle'};this.queue.push({kind:'result',sessionId:this.sid,numTurns:1,durationMs:1})}
}
// 同 service-one-session.test.ts:这里也有毫秒级的注入档位,满载套件里整串会被放大好几倍。
vi.setConfig({testTimeout:60_000})
const POLL={timeout:20_000}
let area:string,project:string,db:Db,service:WorkbenchService,store:ReturnType<typeof makeWorkbenchStore>,runtimes:TurnRuntime[],grace:number
const git=(...args:string[])=>execFileSync('git',args,{cwd:project,stdio:'pipe',env:{...process.env,GIT_AUTHOR_NAME:'t',GIT_AUTHOR_EMAIL:'t@t',GIT_COMMITTER_NAME:'t',GIT_COMMITTER_EMAIL:'t@t'}})
beforeEach(()=>{
  area=realpathSync(mkdtempSync(join(tmpdir(),'cc-review-boundary-')));project=join(area,'project');mkdirSync(project)
  git('init','-q');writeFileSync(join(project,'README.md'),'base\n');git('add','.');git('commit','-q','-m','base')
  db=openDb({path:join(area,'state.db')});runtimes=[]
  const registry=createProviderRegistry()
  registry.register('claude',{async spawn(_project,context){const r=new TurnRuntime(context);runtimes.push(r);return r.session}},{displayName:'Claude',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  store=makeWorkbenchStore(db);grace=10_000
  // 短让位按测试注入(缺省 15 秒,套件等不起);长空闲保持大值,免得计时器插手别的断言。
  service=makeWorkbenchService({store,registry,stateDir:area,ownerChatId:()=>null,handoffGraceMs:()=>grace,retainedIdleCloseMs:()=>10_000})
})
afterEach(async()=>{await service?.shutdown();db.close();removeTempDir(area)})
const settled=async(id:string)=>{await expect.poll(()=>service.detail(id).task.status,POLL).not.toMatch(/^(running|queued|cancelling)$/)}
const reviews=(id:string)=>service.detail(id).artifacts.filter(a=>a.name.startsWith('代码变更')).sort((x,y)=>x.name.localeCompare(y.name)).map(a=>({name:a.name,files:(JSON.parse(readArtifactSnapshot(store.artifact(id,a.id).storagePath,area,a.sha256).toString()) as {files:Array<{path:string;kind:string}>}).files.filter(f=>f.kind!=='not_reviewed').map(f=>f.path).sort()}))

it('同一条 run 的两个回合各截一份快照;B 要等 A 收工才进得来,改的文件记在自己账上',async()=>{
  const a=service.create({path:project,providerId:'claude',text:'A'})
  await expect.poll(()=>service.detail(a.id).events.some(e=>e.kind==='text'),POLL).toBe(true)
  writeFileSync(join(project,'a.txt'),'by A\n')
  runtimes[0]!.finishTurn()
  await expect.poll(()=>service.detail(a.id).task.phase,POLL).toBe('replied')
  // A 的第一轮差异:只有 a.txt(回合安静时就截,不必等结算)
  await expect.poll(()=>reviews(a.id).length,POLL).toBe(1)
  expect(reviews(a.id)[0]!.files).toEqual(['a.txt'])
  // A 续接:重新取基线;A 这一轮改 a2.txt
  await service.submitInput(a.id,{runId:service.detail(a.id).runId!,requestId:'11111111-1111-4111-8111-111111111111',text:'再来'})
  await expect.poll(()=>runtimes[0]!.submitted,POLL).toBe(1)
  writeFileSync(join(project,'a2.txt'),'by A again\n')
  runtimes[0]!.finishTurn()
  await expect.poll(()=>reviews(a.id).length,POLL).toBe(2)
  // 两份快照各只含自己那一轮的文件(不按列表顺序断言)
  expect(reviews(a.id).map(r=>r.files).sort((x,y)=>x[0]!.localeCompare(y[0]!))).toEqual([['a.txt'],['a2.txt']])
  // B 进来:A 还开着,所以 B 先排队;短让位到点 A 自动收工,B 才起跑
  grace=20
  const b=service.create({path:project,providerId:'claude',text:'B'})
  await expect.poll(()=>service.detail(a.id).task.status,POLL).toBe('completed')
  // 收工那一下不再重复生成第三份(基线已经被上一轮消费掉了)
  expect(reviews(a.id)).toHaveLength(2)
  await expect.poll(()=>service.detail(b.id).task.status,POLL).toBe('running')
  await expect.poll(()=>service.detail(b.id).events.some(e=>e.kind==='text'),POLL).toBe(true)
  writeFileSync(join(project,'b.txt'),'by B\n')
  runtimes[1]!.finishTurn()
  await expect.poll(()=>service.detail(b.id).task.phase,POLL).toBe('replied')
  await service.cancel(b.id);await settled(b.id)
  // B 的差异只有 b.txt —— A 留在树上的那两个文件不算它的
  expect(reviews(b.id).map(r=>r.files)).toEqual([['b.txt']])
})

it('续接时存储写入失败:空闲自动收工的计时要重新起上,别把文件夹锁死',async()=>{
  const a=service.create({path:project,providerId:'claude',text:'A'})
  await expect.poll(()=>service.detail(a.id).events.some(e=>e.kind==='text'),POLL).toBe(true)
  runtimes[0]!.finishTurn()
  await expect.poll(()=>service.detail(a.id).task.phase,POLL).toBe('replied')
  // B 排在 A 后面:此刻 A 手里是一份 10 秒的短让位计时(这条测试跑不到它)。
  const b=service.create({path:project,providerId:'claude',text:'B'})
  await expect.poll(()=>service.detail(b.id).task.waitingFor?.taskId,POLL).toBe(a.id)
  // 续接的第一件事是取消那份计时。把短让位调到 20ms:失败回滚若不重新起计时,A 就再没有
  // 任何东西会让它收工 —— B 永远等下去(旧实现里这一格是「把刚申请到的租约还回去」)。
  grace=20
  const run=service.detail(a.id).runId!
  const add=store.liveInputs.add
  store.liveInputs.add=()=>{throw Error('disk_full')}
  try{await expect(service.submitInput(a.id,{runId:run,requestId:'22222222-2222-4222-8222-222222222222',text:'再来'})).rejects.toThrow(/^disk_full$/)}
  finally{store.liveInputs.add=add}
  await expect.poll(()=>service.detail(a.id).task.status,POLL).toBe('completed')
  await expect.poll(()=>service.detail(b.id).task.status,POLL).toBe('running')
})
