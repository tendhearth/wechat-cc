import {afterEach,beforeEach,expect,it} from 'vitest'
import {createHash,randomUUID} from 'node:crypto'
import {mkdirSync,mkdtempSync,realpathSync,writeFileSync} from 'node:fs'
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
 * 「回忆」只在终态触发,不在 settleQuiet(fix round 3/5,2026-09-23,复审
 * 必判①):round 1/2 曾经在 settleQuiet 那一拍(答复静下来)也触发过一次
 * recollectOnce,round 3 去掉了那处——它跟"持久去重、按 matter 只给一
 * 条"的设计天生冲突:matter 隔夜第一次静下来就够格(overnight),凭标题
 * 写一句空话用掉唯一配额,之后主人打回好几次的「波折」反而被已经写过的
 * 那条挡住,留下的恰好是最没内容的那条。只有写在**结局**时,"一件事一
 * 段记述"(持久去重)与"最该记住的是波折"(spec 判据)才同时成立——
 * `turnSeq` 到终态才是这个 run 真实的总轮数。
 *
 * 这个文件因此测三件事:①settleQuiet 安静下来**不**触发 recollect;
 * ②多轮续接之后只在最终收尾时触发一次,带着累计的 turnSeq(不是每次
 * settleQuiet 各触发一次);③`status==='interrupted'` 排除在外、且不会
 * 永久堵死这个 matter——它续接之后真正收尾时才第一次触发。"够不够格、
 * 要不要真的问模型、真的落 journal"是 daemon 侧 makeRecollectSink 的事
 * (recollect-sink.test.ts),这个文件只管 service 这一层什么时候调
 * `opts.recollect.maybeTrigger`。
 *
 * TurnRuntime 抄自 service-report.test.ts / service-matters.test.ts 的写
 * 法:回合要保持在「retained + running」才能手动 finishTurn() 精确踩中
 * settleQuiet 的判据;要走到终态还需要显式 `service.cancel(...)`——已经
 * 答复过的任务被取消时记 `completed`(`closedWhileReplied`,不是
 * `cancelled`),这是让这类 fixture 确定性地走到终态的既有惯例。
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
async function settle(id:string){await expect.poll(()=>service.detail(id).task.status).not.toMatch(/^(queued|running|cancelling)$/)}
function deferred<T=void>(){let resolve!:(value:T|PromiseLike<T>)=>void;let reject!:(error?:unknown)=>void;const promise=new Promise<T>((res,rej)=>{resolve=res;reject=rej});return{promise,resolve,reject}}

beforeEach(()=>{
  area=realpathSync(mkdtempSync(join(tmpdir(),'cc-service-recollect-')));project=join(area,'project');mkdirSync(project)
  db=openDb({path:join(area,'state.db')});matters=makeMatterStore(db);triggered=[];logs=[]
})
afterEach(async()=>{await service?.shutdown();db.close();removeTempDir(area)})

it('settleQuiet 安静下来(答复完)——不触发 recollect,只走到 replied',async()=>{
  const runtime=makeService(makeSink())
  const projectId=service.projects()[0]!.id
  const receipt=createTaskFromChat(projectId)
  await expect.poll(()=>matters.sessions(receipt.taskId)).not.toHaveLength(0)
  runtime.finishTurn()
  await expect.poll(()=>matters.get(receipt.taskId)?.status).toBe('replied')
  expect(triggered).toEqual([]) // fix round 3:settleQuiet 这一处已经不调 recollectOnce 了
})

it('多轮续接之后,只在最终收尾(cancel→completed)时触发一次,带着累计的 turnSeq',async()=>{
  const runtime=makeService(makeSink())
  const projectId=service.projects()[0]!.id
  const receipt=createTaskFromChat(projectId)
  await expect.poll(()=>matters.sessions(receipt.taskId)).not.toHaveLength(0)
  runtime.finishTurn()
  await expect.poll(()=>matters.get(receipt.taskId)?.status).toBe('replied')
  let runId=service.detail(receipt.taskId).runId!
  await service.submitInput(receipt.taskId,{runId,requestId:randomUUID(),text:'再改一下'})
  runtime.finishTurn() // turnSeq → 1
  await expect.poll(()=>matters.get(receipt.taskId)?.status).toBe('replied')
  runId=service.detail(receipt.taskId).runId!
  await service.submitInput(receipt.taskId,{runId,requestId:randomUUID(),text:'再改一下'})
  runtime.finishTurn() // turnSeq → 2
  await expect.poll(()=>matters.get(receipt.taskId)?.status).toBe('replied')
  expect(triggered).toEqual([]) // 三次 settleQuiet,一次都没触发
  // 已经答复过的任务被取消 ⇒ 记 completed(closedWhileReplied),走终态那条路径。
  await service.cancel(receipt.taskId)
  await settle(receipt.taskId)
  expect(triggered).toEqual([[receipt.taskId,2]]) // 只有这一条,带着最终累计的 turnSeq
  await expect.poll(()=>matters.get(receipt.taskId)?.status).toBe('done')
})

it('没有 opts.recollect 时(老接线),终态收尾也什么都不做,不报错',async()=>{
  const runtime=makeService(undefined)
  const projectId=service.projects()[0]!.id
  const receipt=createTaskFromChat(projectId)
  await expect.poll(()=>matters.sessions(receipt.taskId)).not.toHaveLength(0)
  runtime.finishTurn()
  await expect.poll(()=>matters.get(receipt.taskId)?.status).toBe('replied')
  await service.cancel(receipt.taskId)
  await settle(receipt.taskId)
  expect(triggered).toEqual([])
})

/**
 * fix round 2(2026-09-23,复审新 Important ②):recollect.maybeTrigger 抛
 * 错必须被 recollectOnce 吞掉、留痕——对位的 reportOnce(service.ts:596-600)
 * 专门包了 try/catch,recollectOnce 第一版裸调,抛错会穿出调用点(这条调
 * 用点自己没有 try/catch),复审实测这会让终态提交那个 try 块被外层那句
 * "never unlock an uncertain writer for a status failure" 的 catch 整个
 * 吞掉,matter 状态卡在半路。fix round 3 把触发点挪到终态之后,这条用
 * 例跟着挪:验证的是终态那条路径上的 try/catch,不再是 settleQuiet 那条
 * (round 3 已经去掉了)。
 */
it('recollect.maybeTrigger 抛错:留痕(MATTER_RECOLLECT),不打断终态收尾——matter 照样到 done',async()=>{
  const runtime=makeService(makeSink(new Error('recollect_boom')))
  const projectId=service.projects()[0]!.id
  const receipt=createTaskFromChat(projectId)
  await expect.poll(()=>matters.sessions(receipt.taskId)).not.toHaveLength(0)
  runtime.finishTurn()
  await expect.poll(()=>matters.get(receipt.taskId)?.status).toBe('replied')
  await service.cancel(receipt.taskId)
  await settle(receipt.taskId)
  await expect.poll(()=>matters.get(receipt.taskId)?.status).toBe('done')
  expect(triggered).toEqual([[receipt.taskId,0]])
  expect(logs.some(([tag,line])=>tag==='MATTER_RECOLLECT'&&line.includes(receipt.taskId)&&line.includes('recollect_boom'))).toBe(true)
})

/**
 * fix round 2(2026-09-23,复审必判 ①,NOT ADDRESSED → round 2 补上;fix
 * round 3 M4:这条注释原来说夹具"没有 workbenchRuntime",但下面这个
 * fixture 其实**带着** `workbenchRuntime`(只是 `retained:false`)——
 * 覆盖的是 settleQuiet 门 `!snapshot?.retained` 这一半判据,不是"完全没
 * 有 workbenchRuntime"那种真实形状。真 agy 那种字面上**没有**
 * `workbenchRuntime` 字段的情况,由 `wire-workbench.test.ts` 的 e2e 覆
 * 盖(那边的 fixture 只有 `dispatch`/`cancel`/`close`)。这条用例本身仍
 * 然成立:无论是"有 workbenchRuntime 但 retained:false"还是"根本没有
 * workbenchRuntime",`runtimeSnapshot()` 在 settleQuiet 第一行的门上都
 * 会被挡,只走终态提交那条路径。
 */
it('runtimeSnapshot 的 retained:false 分支(settleQuiet 挡住的那一半):completed 终态也触发 recollect',async()=>{
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

it('同一分支以 failed 终态收尾:也触发 recollect(不再继承 completed 门——「波折」正是回忆最想记住的)',async()=>{
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

/**
 * fix round 3(2026-09-23,新 Important):`status==='interrupted'`(写手没
 * 确认退出,`close()` 在 `closeTimeoutMs` 内没能返回)排除在外——见
 * service.ts 终态那处注释,`matterSync` 上面那一行把 matter 设回 'open',
 * 故事没完。这条直接照抄 `service.test.ts`「allows archive only after
 * positive late writer exit evidence」那条用例的手法(`closeGate` 永不
 * resolve、`closeTimeoutMs:5`)——这是**真的**在 `execute()` 自己的
 * `finally` 块里把 `finalStatus` 算成 `'interrupted'`,直接命中 service.ts
 * 里新加的 `if (status!=='interrupted') recollectOnce(running)` 那一行判
 * 断(跟下面那条"daemon 重启检测到的孤儿任务"用例是两种不同机制:那条
 * 走的是 `service.detail()` 读时探测,根本不会第二次进 `execute()` 的
 * finally,不直接命中这一行判断——这条才直接命中)。
 */
it('interrupted(写手没确认退出,close 超时):recollectOnce 确实没被调',async()=>{
  const closeGate=deferred<void>()
  const registry=createProviderRegistry()
  registry.register('claude',{async spawn(){return{async *dispatch(){yield{kind:'result',sessionId:'x',numTurns:1,durationMs:1}},async close(){await closeGate.promise}}}},
    {displayName:'Claude',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  service=makeWorkbenchService({store:makeWorkbenchStore(db),registry,stateDir:area,ownerChatId:()=>'chat-1',matters,
    registeredProjects:()=>[{alias:'project',path:project}],recollect:makeSink(),log:(tag,line)=>logs.push([tag,line]),closeTimeoutMs:5})
  const projectId=service.projects()[0]!.id
  const receipt=createTaskFromChat(projectId)
  await settle(receipt.taskId)
  expect(service.detail(receipt.taskId).task.status).toBe('interrupted')
  expect(triggered).toEqual([])
  closeGate.resolve() // 收尾;不需要再验证"之后会不会重新触发"——那不是这条要测的(见下一条)。
})

/**
 * fix round 3(2026-09-23,评审"要你验证的一点"):排除 interrupted 是不是
 * 等于"这件事永远不会被记"?不是——同一次 close-timeout 造成的
 * interrupted,写手后来（`closeGate.resolve()`)真的退出了、
 * `confirmLateClose` 把 `running.uncertain` 清掉、释放了这条路径的占
 * 用,主人继续这个**同一个 taskId/matterId** 的任务,新的一轮真正收尾
 * (这次是 completed)时,recollectOnce 才第一次被调——不是"用掉过一次
 * 机会,以后永远不会触发"。
 */
it('interrupted(写手确认退出后)可以被继续,真正收尾时 recollectOnce 才第一次触发',async()=>{
  const closeGate=deferred<void>()
  const registry=createProviderRegistry()
  let dispatchCalls=0
  registry.register('claude',{async spawn(){return{async *dispatch(){
    dispatchCalls++
    if(dispatchCalls===1){yield{kind:'result',sessionId:'x',numTurns:1,durationMs:1};return}
    yield{kind:'result',sessionId:'x',numTurns:1,durationMs:1}
  },async close(){if(dispatchCalls===1)await closeGate.promise}}}},
    {displayName:'Claude',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  service=makeWorkbenchService({store:makeWorkbenchStore(db),registry,stateDir:area,ownerChatId:()=>'chat-1',matters,
    registeredProjects:()=>[{alias:'project',path:project}],recollect:makeSink(),log:(tag,line)=>logs.push([tag,line]),closeTimeoutMs:5})
  const projectId=service.projects()[0]!.id
  const receipt=createTaskFromChat(projectId)
  await settle(receipt.taskId)
  expect(service.detail(receipt.taskId).task.status).toBe('interrupted')
  expect(triggered).toEqual([]) // 第一次:close 超时,没有触发

  closeGate.resolve() // 写手其实退出了,只是慢——confirmLateClose 会把 uncertain 清掉、释放占用。
  await expect.poll(()=>service.detail(receipt.taskId).task.canArchive).toBe(true)

  const recovered=service.detail(receipt.taskId)
  const restartToken=recovered.continuation?.mode==='restart_required'?recovered.continuation.restart!.token:undefined
  service.continueTask(receipt.taskId,'继续',restartToken?{restartToken}:undefined)
  await settle(receipt.taskId)

  // 真正收尾了(这次 close() 立刻返回,不再超时)——recollectOnce 这时候
  // 才第一次触发,同一个 taskId,不是被永久用掉了配额。
  expect(triggered).toEqual([[receipt.taskId,0]])
})
