import {afterEach,beforeEach,expect,it} from 'vitest'
import {mkdtempSync,mkdirSync,realpathSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {openDb,type Db} from '../../lib/db'
import {AsyncQueue} from '../async-queue'
import {createProviderRegistry} from '../provider-registry'
import type {AgentEvent,AgentRuntimeSnapshot,AgentSession,AgentWorkbenchRuntime,SpawnContext} from '../agent-provider'
import {makeWorkbenchStore} from './store'
import {makeWorkbenchService,type WorkbenchService} from './service'
import {MANAGED_NATIVE_CAPABILITIES} from './executor-capabilities'
import {removeTempDir} from '../../lib/test-temp'

/**
 * 一个文件夹,同时只有一个**还能写它**的会话:占用从派发开始,到那个会话被关闭为止
 * (docs/superpowers/specs/2026-09-21-one-folder-one-session-design.md)。
 *
 * 2026-09-15 起这里写的是「答复即释放、续接时再申请」,前提是「已答复的保留会话不再写东西」——
 * 那句是假的(后台通知随时唤醒它,`foreground` 能自己从 idle 翻回 running,没有任何事件预告)。
 * 所以这两条测试换了方向:答复之后 B 仍然排队;文件夹要等 A 的会话被关掉才让出来。
 * 2026-09-15 的真痛点(主人只能取消一件做成了的事来疏通)由空闲自动收工解决,见
 * service-one-session.test.ts。
 */
let sessions=0
class TurnRuntime {
  sid:string
  queue=new AsyncQueue<AgentEvent>()
  state:AgentRuntimeSnapshot={retained:true,foreground:'running',backgroundCount:0,input:'send'}
  subscribed=false; submitted:string[]=[]
  // 恢复时原生会话号不变:service 会把 spawn 时收到的 resumeSessionId 跟 init 报的对一遍。
  constructor(context:SpawnContext){this.sid=context.resumeSessionId??`lease-session-${++sessions}`}
  runtime:AgentWorkbenchRuntime={
    events:{[Symbol.asyncIterator]:()=>{this.subscribed=true;return this.queue.iterable()[Symbol.asyncIterator]()}},
    start:()=>{if(!this.subscribed)throw Error('runtime_start_without_consumer');this.queue.push({kind:'init',sessionId:this.sid});this.queue.push({kind:'text',itemId:`t${this.submitted.length}`,text:'正在做。'})},
    submit:async(_id,text)=>{this.submitted.push(text);this.state={...this.state,foreground:'running'};this.queue.push({kind:'text',itemId:`t${this.submitted.length}`,text:'接着做。'})},
    snapshot:()=>this.state,
  }
  session:AgentSession={workbenchRuntime:this.runtime,async *dispatch(){},close:async()=>{this.queue.end()}}
  finishTurn(){this.state={...this.state,foreground:'idle'};this.queue.push({kind:'result',sessionId:this.sid,numTurns:1,durationMs:1})}
}
// 注入一个远大于下面 pause(100) + 两次 poll 的短让位档位(终审 M2):不注入就是吃缺省 15 秒,
// 满载套件里「关会话 → 结算 → pump → spawn」这一串会被放大好几倍(见 vitest.config.ts 那笔账),
// 到不了点是走运,不是断言——这正是本轮已经裁决过一次的满载假红形状。POLL 的超时留在 20 秒:
// 用到它的地方都是 service.cancel() 之后立即收工，不依赖这个 60 秒的档位真的到点。
const POLL={timeout:20_000}
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))

let area:string,project:string,db:Db,service:WorkbenchService,runtimes:TurnRuntime[]
beforeEach(()=>{
  area=realpathSync(mkdtempSync(join(tmpdir(),'cc-lease-')));project=join(area,'project');mkdirSync(project);db=openDb({path:join(area,'state.db')})
  runtimes=[];const registry=createProviderRegistry()
  registry.register('claude',{async spawn(_project,context){const r=new TurnRuntime(context);runtimes.push(r);return r.session}},{displayName:'Claude',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  service=makeWorkbenchService({store:makeWorkbenchStore(db),registry,stateDir:area,ownerChatId:()=>null,handoffGraceMs:()=>60_000})
})
afterEach(async()=>{await service?.shutdown();db.close();removeTempDir(area)})
const create=(text:string)=>service.create({path:project,providerId:'claude',text})
const phase=(id:string)=>service.detail(id).task.phase
const status=(id:string)=>service.detail(id).task.status

it('答复之后文件夹还是它的:B 仍然排队,会话收工之后才起',async()=>{
  const a=create('第一件');await expect.poll(()=>service.detail(a.id).events.some(e=>e.kind==='text'),POLL).toBe(true)
  const b=create('第二件')
  await expect.poll(()=>service.detail(b.id).task.waitingFor?.taskId,POLL).toBe(a.id)
  runtimes[0]!.finishTurn()
  await expect.poll(()=>phase(a.id),POLL).toBe('replied')
  // 答复 ≠ 文件夹空了:A 的会话还开着,它随时会被后台通知唤醒自己又动手。短让位注入成 60 秒,
  // 这条测试到不了那一下 —— 所以这里看到的是「还在排队」这个不变式本身,不是计时器。
  await pause(100)
  expect(status(b.id)).toBe('queued')
  expect(service.detail(b.id).task.waitingFor).toMatchObject({taskId:a.id,reason:'same_path'})
  // 收工(主人点结束,或空闲自动让位)之后才轮到 B。答复早已交付,所以终态是 completed/replied。
  await service.cancel(a.id)
  await expect.poll(()=>status(a.id),POLL).toBe('completed')
  expect(phase(a.id)).toBe('replied')
  await expect.poll(()=>status(b.id),POLL).toBe('running')
})

it('已经收工的任务要续接、文件夹正被别人占着:排队等它,不并写',async()=>{
  const a=create('第一件');await expect.poll(()=>service.detail(a.id).events.some(e=>e.kind==='text'),POLL).toBe(true)
  runtimes[0]!.finishTurn();await expect.poll(()=>phase(a.id),POLL).toBe('replied')
  await service.cancel(a.id);await expect.poll(()=>status(a.id),POLL).toBe('completed')
  const b=create('第二件');await expect.poll(()=>status(b.id),POLL).toBe('running')
  // A 已结算:续接走 continueTask + 队列。不抛 workbench_busy,也不会悄悄并写 ——
  // 它排在占着这个文件夹的 B 后面(没有第三个执行者被放进来)。
  service.continueTask(a.id,'再补一句')
  await expect.poll(()=>service.detail(a.id).task.waitingFor?.taskId,POLL).toBe(b.id)
  expect(runtimes).toHaveLength(2)
  runtimes[1]!.finishTurn();await expect.poll(()=>phase(b.id),POLL).toBe('replied')
  await service.cancel(b.id);await expect.poll(()=>status(b.id),POLL).toBe('completed')
  // B 让出文件夹 ⇒ A 起来,而且按原会话恢复(原生会话号不变)。
  await expect.poll(()=>runtimes.length,POLL).toBe(3)
  await expect.poll(()=>status(a.id),POLL).toBe('running')
  expect(runtimes[2]!.sid).toBe(runtimes[0]!.sid)
})
