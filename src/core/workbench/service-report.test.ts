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
  runtime:AgentWorkbenchRuntime={
    events:{[Symbol.asyncIterator]:()=>{this.subscribed=true;return this.queue.iterable()[Symbol.asyncIterator]()}},
    start:()=>{if(!this.subscribed)throw Error('runtime_start_without_consumer');this.queue.push({kind:'init',sessionId:'native-1'});this.queue.push({kind:'text',itemId:'t0',text:'做。'})},
    submit:async()=>{},
    snapshot:()=>this.state,
  }
  session:AgentSession={workbenchRuntime:this.runtime,async *dispatch(){},close:async()=>{this.queue.end()}}
  finishTurn(){this.state={...this.state,foreground:'idle'};this.queue.push({kind:'result',sessionId:'native-1',numTurns:1,durationMs:1})}
}
let area:string,project:string,db:Db,service:WorkbenchService,matters:MatterStore,logs:Array<[string,string]>,enqueued:string[]
function makeSink(fail?:Error):ReportSink { return {enqueue(matterId){enqueued.push(matterId);if(fail)throw fail}} }
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
  db=openDb({path:join(area,'state.db')});matters=makeMatterStore(db);logs=[];enqueued=[]
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
