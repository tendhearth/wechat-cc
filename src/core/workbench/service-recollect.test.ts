import {afterEach,beforeEach,expect,it} from 'vitest'
import {createHash,randomUUID} from 'node:crypto'
import {mkdirSync,mkdtempSync,realpathSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {openDb,type Db} from '../../lib/db'
import {removeTempDir} from '../../lib/test-temp'
import {AsyncQueue} from '../async-queue'
import {createProviderRegistry} from '../provider-registry'
import type {AgentEvent,AgentRuntimeSnapshot,AgentSession,AgentWorkbenchRuntime} from '../agent-provider'
import {makeWorkbenchStore} from './store'
import {makeWorkbenchService,type WorkbenchService} from './service'
import {MANAGED_NATIVE_CAPABILITIES} from './executor-capabilities'
import {makeMatterStore,type MatterStore} from '../matters/store'
import type {RecollectSink} from '../matters/recollection'

/**
 * settleQuiet 那一拍触发「回忆」(fix round 1/5,2026-09-23,控制器裁决:
 * "这一轮必须接上能接的那部分",与 Task 3 的 reportOnce 挂在同一处、紧随
 * 其后)。这里只测 service 这一层的接线——"够不够格、要不要真的问模型、
 * 真的落 journal"是 daemon 侧 makeRecollectSink 的事(recollect-sink.test.ts),
 * 这个文件只证明 `settleQuiet` 确实带着 `taskId` 和当时的 `turnSeq` 调了
 * `opts.recollect.maybeTrigger`,而且没有 `opts.recollect` 时不报错。
 *
 * TurnRuntime 抄自 service-report.test.ts / service-matters.test.ts 的写
 * 法:回合要保持在「retained + running」才能手动 finishTurn() 精确踩中
 * settleQuiet 的判据。
 */
class TurnRuntime {
  queue=new AsyncQueue<AgentEvent>()
  state:AgentRuntimeSnapshot={retained:true,foreground:'running',backgroundCount:0,input:'send'}
  subscribed=false
  runtime:AgentWorkbenchRuntime={
    events:{[Symbol.asyncIterator]:()=>{this.subscribed=true;return this.queue.iterable()[Symbol.asyncIterator]()}},
    start:()=>{if(!this.subscribed)throw Error('runtime_start_without_consumer');this.queue.push({kind:'init',sessionId:'native-1'});this.queue.push({kind:'text',itemId:'t0',text:'做。'})},
    submit:async()=>{this.queue.push({kind:'result',sessionId:'native-1',numTurns:1,durationMs:1})},
    snapshot:()=>this.state,
  }
  session:AgentSession={workbenchRuntime:this.runtime,async *dispatch(){},close:async()=>{this.queue.end()}}
  finishTurn(){this.state={...this.state,foreground:'idle'};this.queue.push({kind:'result',sessionId:'native-1',numTurns:1,durationMs:1})}
}
let area:string,project:string,db:Db,service:WorkbenchService,matters:MatterStore,triggered:Array<[string,number]>,logs:Array<[string,string]>
function makeSink(fail?:Error):RecollectSink { return {maybeTrigger(taskId,turns){triggered.push([taskId,turns]);if(fail)throw fail}} }
function makeService(recollect?:RecollectSink){
  const registry=createProviderRegistry();const runtime=new TurnRuntime()
  registry.register('claude',{async spawn(){return runtime.session}},{displayName:'Claude',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  service=makeWorkbenchService({store:makeWorkbenchStore(db),registry,stateDir:area,ownerChatId:()=>'chat-1',matters,
    registeredProjects:()=>[{alias:'project',path:project}],recollect,log:(tag,line)=>logs.push([tag,line])})
  return runtime
}
function createTaskFromChat(projectId:string){
  return service.createWechat({ownerChatId:'chat-1',accountId:'acct-1',requestId:randomUUID(),commandHash:createHash('sha256').update('改首页').digest('hex'),originMessageId:'msg-7',projectId,providerId:'claude',text:'改首页'})
}

beforeEach(()=>{
  area=realpathSync(mkdtempSync(join(tmpdir(),'cc-service-recollect-')));project=join(area,'project');mkdirSync(project)
  db=openDb({path:join(area,'state.db')});matters=makeMatterStore(db);triggered=[];logs=[]
})
afterEach(async()=>{await service?.shutdown();db.close();removeTempDir(area)})

it('答复静下来那一拍,调用 recollect.maybeTrigger(taskId, turnSeq)',async()=>{
  const runtime=makeService(makeSink())
  const projectId=service.projects()[0]!.id
  const receipt=createTaskFromChat(projectId)
  await expect.poll(()=>matters.sessions(receipt.taskId)).not.toHaveLength(0)
  runtime.finishTurn()
  await expect.poll(()=>matters.get(receipt.taskId)?.status).toBe('replied')
  // 第一次答复还没有任何续接,turnSeq 还是 0。
  expect(triggered).toEqual([[receipt.taskId,0]])
})

it('主人续接一次:第二次触发带着新的 turnSeq(1),不是重复上一次的 0',async()=>{
  const runtime=makeService(makeSink())
  const projectId=service.projects()[0]!.id
  const receipt=createTaskFromChat(projectId)
  await expect.poll(()=>matters.sessions(receipt.taskId)).not.toHaveLength(0)
  runtime.finishTurn()
  await expect.poll(()=>matters.get(receipt.taskId)?.status).toBe('replied')
  expect(triggered).toEqual([[receipt.taskId,0]])
  const runId=service.detail(receipt.taskId).runId!
  await service.submitInput(receipt.taskId,{runId,requestId:randomUUID(),text:'再改一下'})
  runtime.finishTurn()
  await expect.poll(()=>triggered.length).toBe(2)
  expect(triggered).toEqual([[receipt.taskId,0],[receipt.taskId,1]])
})

it('没有 opts.recollect 时(老接线),什么都不做,不报错',async()=>{
  const runtime=makeService(undefined)
  const projectId=service.projects()[0]!.id
  const receipt=createTaskFromChat(projectId)
  await expect.poll(()=>matters.sessions(receipt.taskId)).not.toHaveLength(0)
  runtime.finishTurn()
  await expect.poll(()=>matters.get(receipt.taskId)?.status).toBe('replied')
  expect(triggered).toEqual([])
})

/**
 * fix round 2(2026-09-23,复审新 Important ②):recollect.maybeTrigger 抛
 * 错必须被 recollectOnce 吞掉、留痕——对位的 reportOnce(service.ts:596-600)
 * 专门包了 try/catch,recollectOnce 第一版裸调,抛错会穿出 settleQuiet(这
 * 条调用点自己没有 try/catch),复审实测这会让 matter 永远到不了 replied、
 * 直接变 done,captureCodeChanges/armIdleClose 全被跳过。
 */
it('recollect.maybeTrigger 抛错:留痕(MATTER_RECOLLECT),不打断 settleQuiet——matter 照样到 replied',async()=>{
  const runtime=makeService(makeSink(new Error('recollect_boom')))
  const projectId=service.projects()[0]!.id
  const receipt=createTaskFromChat(projectId)
  await expect.poll(()=>matters.sessions(receipt.taskId)).not.toHaveLength(0)
  runtime.finishTurn()
  await expect.poll(()=>matters.get(receipt.taskId)?.status).toBe('replied')
  expect(triggered).toEqual([[receipt.taskId,0]])
  expect(logs.some(([tag,line])=>tag==='MATTER_RECOLLECT'&&line.includes(receipt.taskId)&&line.includes('recollect_boom'))).toBe(true)
})

/**
 * fix round 2(2026-09-23,复审必判 ①,NOT ADDRESSED → 这轮补):非 retained
 * 执行者(agy/cursor/openai 那类,没有 workbenchRuntime)永不经过
 * settleQuiet——runtimeSnapshot() 在没有 workbenchRuntime 时返回 undefined,
 * settleQuiet 第一行的门就直接 return。它们只走终态提交那条路径
 * (service.ts:891 一带),那里以前只在 status==='completed' 时调
 * reportOnce,这一轮在同一处**无条件**调 recollectOnce——不继承那道
 * completed 门,因为回忆恰恰最想记住"反复失败、被打回"这一类。
 */
it('非 retained 执行者(没有 workbenchRuntime):completed 终态也触发 recollect',async()=>{
  const registry=createProviderRegistry()
  const q=new AsyncQueue<AgentEvent>()
  const state:AgentRuntimeSnapshot={retained:false,foreground:'running',backgroundCount:0,input:'send'}
  registry.register('claude',{async spawn(){return{
    workbenchRuntime:{
      events:{[Symbol.asyncIterator]:()=>q.iterable()[Symbol.asyncIterator]()},
      start:()=>{q.push({kind:'init',sessionId:'nr-1'});q.push({kind:'text',itemId:'t0',text:'done.'});q.push({kind:'result',sessionId:'nr-1',numTurns:1,durationMs:1});q.end()},
      submit:async()=>{},
      snapshot:()=>state,
    } as AgentWorkbenchRuntime,
    async *dispatch(){},close:async()=>{},
  }}},{displayName:'Claude',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  service=makeWorkbenchService({store:makeWorkbenchStore(db),registry,stateDir:area,ownerChatId:()=>'chat-1',matters,
    registeredProjects:()=>[{alias:'project',path:project}],recollect:makeSink(),log:(tag,line)=>logs.push([tag,line])})
  const projectId=service.projects()[0]!.id
  const receipt=createTaskFromChat(projectId)
  await expect.poll(()=>matters.get(receipt.taskId)?.status).toBe('done')
  expect(triggered).toEqual([[receipt.taskId,0]])
})

it('非 retained 执行者以 failed 终态收尾:也触发 recollect(不再继承 completed 门——「波折」正是回忆最想记住的)',async()=>{
  const registry=createProviderRegistry()
  const q=new AsyncQueue<AgentEvent>()
  const state:AgentRuntimeSnapshot={retained:false,foreground:'running',backgroundCount:0,input:'send'}
  registry.register('claude',{async spawn(){return{
    workbenchRuntime:{
      events:{[Symbol.asyncIterator]:()=>q.iterable()[Symbol.asyncIterator]()},
      start:()=>{q.push({kind:'init',sessionId:'nr-2'});q.push({kind:'error',message:'provider exploded'});q.end()},
      submit:async()=>{},
      snapshot:()=>state,
    } as AgentWorkbenchRuntime,
    async *dispatch(){},close:async()=>{},
  }}},{displayName:'Claude',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  service=makeWorkbenchService({store:makeWorkbenchStore(db),registry,stateDir:area,ownerChatId:()=>'chat-1',matters,
    registeredProjects:()=>[{alias:'project',path:project}],recollect:makeSink(),log:(tag,line)=>logs.push([tag,line])})
  const projectId=service.projects()[0]!.id
  const receipt=createTaskFromChat(projectId)
  await expect.poll(()=>service.detail(receipt.taskId).task.status).toBe('failed')
  await expect.poll(()=>matters.get(receipt.taskId)?.status).toBe('done')
  expect(triggered).toEqual([[receipt.taskId,0]]) // 旧行为(继承 completed 门)下这里会是 []
})
