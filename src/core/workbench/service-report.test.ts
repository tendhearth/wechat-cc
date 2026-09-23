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
import type {ReportSink} from '../matters/report'
import {makeReportSink} from '../../daemon/reports/report-sink'
import {makeReportOutboxStore} from '../../daemon/reports/outbox'

/**
 * settleQuiet 那一拍入队回报(docs/cc-workbench.md「一件事」;task-3,2026-09-23):
 * `matterSync(...setStatus('replied'))` 之后另起一句调用 `opts.reports.enqueue`,
 * 不挂进 matterSync —— 那个包装故意吞掉所有异常,回报挂进去会把"从来没报成功
 * 过"伪装成"偶尔漏一条"(2026-09 的教训,brief 三条裁决之一)。renderReport
 * 本身该不该报(有没有出生地)是纯逻辑那边的事,这里只管"每次答复都问一声"。
 * TurnRuntime 抄自 service-matters.test.ts:回合要保持在「retained + running」
 * 才能手动 finishTurn() 精确踩中 settleQuiet 的判据,不然 registerEcho 那种一次
 * 吐完的 provider 会直接把任务结算成 done,永远碰不到 replied。
 */
class TurnRuntime {
  queue=new AsyncQueue<AgentEvent>()
  state:AgentRuntimeSnapshot={retained:true,foreground:'running',backgroundCount:0,input:'send'}
  subscribed=false
  said=0
  runtime:AgentWorkbenchRuntime={
    events:{[Symbol.asyncIterator]:()=>{this.subscribed=true;return this.queue.iterable()[Symbol.asyncIterator]()}},
    start:()=>{if(!this.subscribed)throw Error('runtime_start_without_consumer');this.queue.push({kind:'init',sessionId:'native-1'});this.queue.push({kind:'text',itemId:'t0',text:'做。'})},
    // 主人续接的 worst-case:快照从来不拨去 running 再拨回 idle(转移探测器永远看不到
    // "忙碌"这一格),直接吐一个新 result——评审修复轮 1 ①「连续两轮各报一条」那条用例
    // 专门踩的就是这个race:靠快照观察复位去重键的旧写法在这种时序下会漏看新一轮。
    submit:async()=>{this.queue.push({kind:'result',sessionId:'native-1',numTurns:1,durationMs:1})},
    snapshot:()=>this.state,
  }
  session:AgentSession={workbenchRuntime:this.runtime,async *dispatch(){},close:async()=>{this.queue.end()}}
  finishTurn(){this.state={...this.state,foreground:'idle'};this.queue.push({kind:'result',sessionId:'native-1',numTurns:1,durationMs:1})}
  /** 自己又动手了:没有任何 submitInput,快照真的抖了一下(running→idle)——这是
   *  "自动续作连着抖好几次 quiet↔busy" 的最小复现(service.ts:499-501 的注释)。中间让出
   *  一个宏任务,否则两次状态翻转会在事件循环读到第一次之前就都发生完,转移探测器同样
   *  看不到"忙碌"这一格(跟 submit() 复现的是同一类 race,只是这里要反过来避开它,
   *  好让这条用例真的在测"探测器看见了、但合并逻辑要不要压住重复入队")。 */
  async flap(){
    this.state={...this.state,foreground:'running'}
    this.queue.push({kind:'tool_call',tool:'Write',activity:{id:`w${++this.said}`,type:'tool',label:'自动续作',status:'running'}})
    await new Promise(resolve=>setImmediate(resolve))
    this.state={...this.state,foreground:'idle'}
    this.queue.push({kind:'result',sessionId:'native-1',numTurns:1,durationMs:1})
  }
}
let area:string,project:string,db:Db,service:WorkbenchService,matters:MatterStore,logs:Array<[string,string]>,enqueued:string[],enqueuedTurns:number[]
function makeSink(fail?:Error):ReportSink { return {enqueue(matterId,turn){enqueued.push(matterId);enqueuedTurns.push(turn);if(fail)throw fail}} }
function makeService(reports?:ReportSink){
  const registry=createProviderRegistry();const runtime=new TurnRuntime()
  registry.register('claude',{async spawn(){return runtime.session}},{displayName:'Claude',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  service=makeWorkbenchService({store:makeWorkbenchStore(db),registry,stateDir:area,ownerChatId:()=>'chat-1',matters,
    registeredProjects:()=>[{alias:'project',path:project}],log:(tag,line)=>logs.push([tag,line]),reports})
  return runtime
}
function createTaskFromChat(projectId:string){
  return service.createWechat({ownerChatId:'chat-1',accountId:'acct-1',requestId:randomUUID(),commandHash:createHash('sha256').update('改首页').digest('hex'),originMessageId:'msg-7',projectId,providerId:'claude',text:'改首页'})
}

beforeEach(()=>{
  area=realpathSync(mkdtempSync(join(tmpdir(),'cc-service-report-')));project=join(area,'project');mkdirSync(project)
  db=openDb({path:join(area,'state.db')});matters=makeMatterStore(db);logs=[];enqueued=[];enqueuedTurns=[]
})
afterEach(async()=>{await service?.shutdown();db.close();removeTempDir(area)})

it('答复静下来那一拍,调用 reports.enqueue(taskId)',async()=>{
  const runtime=makeService(makeSink())
  const projectId=service.projects()[0]!.id
  const receipt=createTaskFromChat(projectId)
  await expect.poll(()=>matters.sessions(receipt.taskId)).not.toHaveLength(0)
  runtime.finishTurn()
  await expect.poll(()=>matters.get(receipt.taskId)?.status).toBe('replied')
  expect(enqueued).toEqual([receipt.taskId])
  // 正常路径不留痕。
  expect(logs).toEqual([])
})

it('reports.enqueue 抛错只落日志,不进 matterSync,不影响答复状态',async()=>{
  const runtime=makeService(makeSink(new Error('outbox_write_failed')))
  const projectId=service.projects()[0]!.id
  const receipt=createTaskFromChat(projectId)
  await expect.poll(()=>matters.sessions(receipt.taskId)).not.toHaveLength(0)
  runtime.finishTurn()
  await expect.poll(()=>matters.get(receipt.taskId)?.status).toBe('replied')
  expect(enqueued).toEqual([receipt.taskId])
  await expect.poll(()=>logs.length).toBeGreaterThan(0)
  expect(logs.some(([,line])=>line.includes(receipt.taskId)&&line.includes('outbox_write_failed'))).toBe(true)
})

it('没有出生地的事(桌面亲手派的)照样入队 —— 该不该报是 renderReport 的事,不是 service 的事',async()=>{
  const runtime=makeService(makeSink())
  const task=service.create({path:project,providerId:'claude',text:'手动派的'})
  await expect.poll(()=>matters.sessions(task.id)).not.toHaveLength(0)
  runtime.finishTurn()
  await expect.poll(()=>matters.get(task.id)?.status).toBe('replied')
  expect(enqueued).toEqual([task.id])
})

it('主人续接开新一轮:连续两轮各报一条(即便两轮之间快照从未被观察到"忙碌")',async()=>{
  // 评审修复轮 1 ①:旧写法(布尔 reported,只在转移探测器亲眼看到"忙碌"快照时复位)
  // 在这种 race 下会漏看第二轮——TurnRuntime.submit 从不把快照拨去 running,直接吐
  // 新 result。去重键换成 turnSeq(在 submitInput 实际投递那个同步点递增,不依赖快照
  // 观察)之后,这条用例才会绿;删掉 service.ts 里 submitInput 那处 `running.turnSeq++`
  // 会让这条用例红在 `expect(enqueued.length).toBe(2)`(停在 1)。
  const runtime=makeService(makeSink())
  const projectId=service.projects()[0]!.id
  const receipt=createTaskFromChat(projectId)
  await expect.poll(()=>matters.sessions(receipt.taskId)).not.toHaveLength(0)
  runtime.finishTurn()
  await expect.poll(()=>matters.get(receipt.taskId)?.status).toBe('replied')
  expect(enqueued).toEqual([receipt.taskId])
  const runId=service.detail(receipt.taskId).runId!
  await service.submitInput(receipt.taskId,{runId,requestId:randomUUID(),text:'再改一下'})
  await expect.poll(()=>enqueued.length).toBe(2)
  expect(enqueued).toEqual([receipt.taskId,receipt.taskId])
  // 终审第 6 项:enqueue 的第二个参数(turn)是 running.turnSeq——两轮各不
  // 相同,是回报文案能区分相邻两轮的前提(措辞本身的用例在 report.test.ts)。
  expect(enqueuedTurns).toEqual([0,1])
})

it('同一轮里自己抖两次(quiet↔busy,没有 submitInput):outbox 只留一条 pending,不是三条',async()=>{
  // 评审修复轮 1 ②:入队侧没有量控——同一 matter 多次入队应该在 outbox 合并成一行,
  // 而不是插三行。这条用例接的是真实 ReportSink + 真实 outbox(不是数组假桩),因为
  // "只报一条"这件事发生在 outbox 那一层,不是 service 少调 enqueue——flap 时 turnSeq
  // 照样推进、enqueue 照样被调用三次(service.ts:499-501 的注释:一段自动续作会连着抖
  // 好几次 quiet↔busy),只是 outbox.insert 把它们落成同一行。删掉 outbox.ts 里的
  // "已有 pending 就更新而不是插入"那段改动,这条用例会红在 `due.length` 变成 3。
  const outbox=makeReportOutboxStore(db)
  const realSink=makeReportSink({matters,outbox,taskTitle:()=>'首页调整',artifactCount:()=>0,notificationsEnabled:()=>true,now:()=>Date.now()})
  // 包一层计数:证明三次 settleQuiet 真的都调用了 enqueue(turnSeq 确实推进了三次)——
  // 不然"outbox 只有一行"可能只是因为 flap 根本没被探测器看见,不是合并逻辑生效。
  let enqueueCalls=0
  const countingSink:ReportSink={enqueue(matterId,turn){enqueueCalls++;realSink.enqueue(matterId,turn)}}
  const runtime=makeService(countingSink)
  const projectId=service.projects()[0]!.id
  const receipt=createTaskFromChat(projectId)
  await expect.poll(()=>matters.sessions(receipt.taskId)).not.toHaveLength(0)
  runtime.finishTurn()
  await expect.poll(()=>enqueueCalls).toBe(1)
  await runtime.flap()
  await expect.poll(()=>enqueueCalls).toBe(2)
  await runtime.flap()
  await expect.poll(()=>enqueueCalls).toBe(3)
  const due=await outbox.listDue(Date.now()+1)
  expect(due).toHaveLength(1)
  expect(due[0]).toMatchObject({matterId:receipt.taskId})
})

it('非 retained 的执行者永不经过 replied(isReplied 要求 snapshot.retained),靠终态 done 那一拍回报(评审修复轮 1 ③)',async()=>{
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
    registeredProjects:()=>[{alias:'project',path:project}],log:(tag,line)=>logs.push([tag,line]),reports:makeSink()})
  const projectId=service.projects()[0]!.id
  const receipt=createTaskFromChat(projectId)
  await expect.poll(()=>matters.get(receipt.taskId)?.status).toBe('done')
  expect(enqueued).toEqual([receipt.taskId])
})

/**
 * 终审 Important②:非 retained 执行者(agy/cursor/openai/gemini 那类)不
 * 经过 settleQuiet,`stageFinishedNotice` 和 `reportOnce` 同在终态那个
 * try 里、同一拍触发,completed 时以前会两条一起外发——先「…这一轮已完
 * 成…查看:任务 xxx」,紧跟「…已答复。…看:… 接着说:…」,同一件事说
 * 了两遍。回报信息更丰富(带续接入口),压的是 stageFinishedNotice 那
 * 条:微信交办、有出生地的任务 completed 时,通知队列里不该再有一条
 * 'completed' 通知——只留回报这一条外发。
 */
it('非 retained 执行者(微信交办、有出生地)completed:stageFinishedNotice 的 completed 通知被压,只留回报一条外发',async()=>{
  const registry=createProviderRegistry()
  const q=new AsyncQueue<AgentEvent>()
  const state:AgentRuntimeSnapshot={retained:false,foreground:'running',backgroundCount:0,input:'send'}
  registry.register('claude',{async spawn(){return{
    workbenchRuntime:{
      events:{[Symbol.asyncIterator]:()=>q.iterable()[Symbol.asyncIterator]()},
      start:()=>{q.push({kind:'init',sessionId:'nr-3'});q.push({kind:'text',itemId:'t0',text:'done.'});q.push({kind:'result',sessionId:'nr-3',numTurns:1,durationMs:1});q.end()},
      submit:async()=>{},
      snapshot:()=>state,
    } as AgentWorkbenchRuntime,
    async *dispatch(){},close:async()=>{},
  }}},{displayName:'Claude',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  const wbStore=makeWorkbenchStore(db)
  service=makeWorkbenchService({store:wbStore,registry,stateDir:area,ownerChatId:()=>'chat-1',matters,
    registeredProjects:()=>[{alias:'project',path:project}],log:(tag,line)=>logs.push([tag,line]),reports:makeSink()})
  const projectId=service.projects()[0]!.id
  const receipt=createTaskFromChat(projectId)
  await expect.poll(()=>matters.get(receipt.taskId)?.status).toBe('done')
  expect(enqueued).toEqual([receipt.taskId]) // 回报确实入队了(有出生地)
  const notices=wbStore.wechatNotifications.list(receipt.taskId)
  expect(notices.some(n=>n.kind==='completed')).toBe(false) // 通知被压——不重叠外发
})

/**
 * 终审 Important②的另一半:压制**只**在"这一轮真的会入队回报"时生效
 * (判据同 renderReport:有没有出生地)。桌面亲手派的任务没有出生地,
 * reportOnce 调了但 renderReport 会返回 null、什么都不写进 outbox——这
 * 种情况必须继续留着 stageFinishedNotice,不能无条件压,否则主人在这条
 * 任务上完全收不到任何微信消息(哪怕他事后在微信里对这条任务说过「提醒
 * 我」)。
 */
it('桌面亲手派的任务(没有出生地):reportOnce 调了但不会真的入队,stageFinishedNotice 的 completed 通知仍然保留',async()=>{
  const registry=createProviderRegistry()
  const q=new AsyncQueue<AgentEvent>()
  const state:AgentRuntimeSnapshot={retained:false,foreground:'running',backgroundCount:0,input:'send'}
  registry.register('claude',{async spawn(){return{
    workbenchRuntime:{
      events:{[Symbol.asyncIterator]:()=>q.iterable()[Symbol.asyncIterator]()},
      start:()=>{q.push({kind:'init',sessionId:'nr-4'});q.push({kind:'text',itemId:'t0',text:'done.'});q.push({kind:'result',sessionId:'nr-4',numTurns:1,durationMs:1});q.end()},
      submit:async()=>{},
      snapshot:()=>state,
    } as AgentWorkbenchRuntime,
    async *dispatch(){},close:async()=>{},
  }}},{displayName:'Claude',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  const wbStore=makeWorkbenchStore(db)
  service=makeWorkbenchService({store:wbStore,registry,stateDir:area,ownerChatId:()=>'chat-1',matters,
    registeredProjects:()=>[{alias:'project',path:project}],log:(tag,line)=>logs.push([tag,line]),reports:makeSink()})
  const task=service.create({path:project,providerId:'claude',text:'手动派的'})
  // 主人事后在微信里对这条(桌面派的)任务说过「提醒我」——这条任务依然
  // 没有出生地(不是从聊天交办的),但确实订阅了完成通知。
  service.setWechatWatch(task.id,'acct-1',true)
  await expect.poll(()=>matters.get(task.id)?.status).toBe('done')
  expect(enqueued).toEqual([task.id]) // reportOnce 照样调了——该不该报是 renderReport 的事
  const notices=wbStore.wechatNotifications.list(task.id)
  expect(notices.some(n=>n.kind==='completed')).toBe(true) // 通知没被压
})

it('非 retained 的执行者以 failed 终态收尾时不入队(评审修复轮 2 ②)——失败不是「已答复」',async()=>{
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
    registeredProjects:()=>[{alias:'project',path:project}],log:(tag,line)=>logs.push([tag,line]),reports:makeSink()})
  const projectId=service.projects()[0]!.id
  const receipt=createTaskFromChat(projectId)
  await expect.poll(()=>service.detail(receipt.taskId).task.status).toBe('failed')
  await expect.poll(()=>matters.get(receipt.taskId)?.status).toBe('done') // matter 侧照样落到 done(失败也是终态)
  expect(enqueued).toEqual([]) // 但不该被当成「已答复」报给主人
})

it('没有 opts.reports 时(老接线),什么都不做,不报错',async()=>{
  const runtime=makeService(undefined)
  const projectId=service.projects()[0]!.id
  const receipt=createTaskFromChat(projectId)
  await expect.poll(()=>matters.sessions(receipt.taskId)).not.toHaveLength(0)
  runtime.finishTurn()
  await expect.poll(()=>matters.get(receipt.taskId)?.status).toBe('replied')
  expect(enqueued).toEqual([])
  expect(logs).toEqual([])
})
