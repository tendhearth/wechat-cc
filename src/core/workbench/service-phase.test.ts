import {afterEach,beforeEach,expect,it} from 'vitest'
import {mkdtempSync,mkdirSync,realpathSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {openDb,type Db} from '../../lib/db'
import {AsyncQueue} from '../async-queue'
import {createProviderRegistry} from '../provider-registry'
import type {AgentEvent,AgentProvider,AgentRuntimeSnapshot,AgentSession,AgentWorkbenchRuntime} from '../agent-provider'
import {makeWorkbenchStore} from './store'
import {makeWorkbenchService,type WorkbenchService} from './service'
import {MANAGED_NATIVE_CAPABILITIES} from './executor-capabilities'
import {removeTempDir} from '../../lib/test-temp'

/**
 * 「这件事做完没有」两家曾答不一致:Codex 答完自动 completed,Claude 答完停在
 * running(会话为续接保留)。主人眼里那是同一个状态 —— 本轮做完了、还能接着说。
 * 这里把它钉成派生的 phase:'replied',并要求关掉一个已答复的会话记成 completed,
 * 而不是把一件做成了的事写成 cancelled(2026-09-15 真机:五个任务全成功,列表上四个「已取消」)。
 */
const result:AgentEvent={kind:'result',sessionId:'turn-session',numTurns:1,durationMs:1}
class TurnRuntime {
  queue=new AsyncQueue<AgentEvent>()
  state:AgentRuntimeSnapshot={retained:true,foreground:'running',backgroundCount:0,input:'send'}
  subscribed=false
  closed=0
  runtime:AgentWorkbenchRuntime={
    events:{[Symbol.asyncIterator]:()=>{this.subscribed=true;return this.queue.iterable()[Symbol.asyncIterator]()}},
    start:()=>{
      if(!this.subscribed)throw Error('runtime_start_without_consumer')
      this.queue.push({kind:'init',sessionId:'turn-session'})
      this.queue.push({kind:'text',itemId:'first',text:'正在做。'})
    },
    submit:async()=>{},
    snapshot:()=>this.state,
  }
  session:AgentSession={workbenchRuntime:this.runtime,async *dispatch(){},close:async()=>{this.closed++;this.queue.end()}}
  finishTurn(){this.state={...this.state,foreground:'idle'};this.queue.push(result)}
}

let area:string,project:string,db:Db,service:WorkbenchService
beforeEach(()=>{area=realpathSync(mkdtempSync(join(tmpdir(),'cc-phase-')));project=join(area,'project');mkdirSync(project);db=openDb({path:join(area,'state.db')})})
afterEach(async()=>{await service?.shutdown();db.close();removeTempDir(area)})

function wire(provider:AgentProvider){
  const registry=createProviderRegistry()
  registry.register('claude',provider,{displayName:'Claude',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  service=makeWorkbenchService({store:makeWorkbenchStore(db),registry,stateDir:area,ownerChatId:()=>null})
}
const settled=async(id:string)=>{await expect.poll(()=>service.detail(id).task.status).not.toMatch(/^(running|queued|cancelling)$/)}

it('is working while the turn streams and replied once it ends with the session retained',async()=>{
  const owned=new TurnRuntime();wire({async spawn(){return owned.session}})
  const task=service.create({path:project,providerId:'claude',text:'做一件事'})
  await expect.poll(()=>service.detail(task.id).events.some(e=>e.kind==='text')).toBe(true)
  expect(service.detail(task.id).task.phase).toBe('working')
  owned.finishTurn()
  await expect.poll(()=>service.detail(task.id).task.phase).toBe('replied')
  expect(service.detail(task.id).task.status).toBe('running')
})

it('records closing a replied session as completed, not cancelled',async()=>{
  const owned=new TurnRuntime();wire({async spawn(){return owned.session}})
  const task=service.create({path:project,providerId:'claude',text:'做一件事'})
  await expect.poll(()=>service.detail(task.id).events.some(e=>e.kind==='text')).toBe(true)
  owned.finishTurn()
  await expect.poll(()=>service.detail(task.id).task.phase).toBe('replied')
  await service.cancel(task.id);await settled(task.id)
  expect(service.detail(task.id).task.status).toBe('completed')
  expect(service.detail(task.id).task.phase).toBe('replied')
  expect(owned.closed).toBe(1)
})

it('still records a cancellation mid-turn as cancelled',async()=>{
  const owned=new TurnRuntime();wire({async spawn(){return owned.session}})
  const task=service.create({path:project,providerId:'claude',text:'做一件事'})
  await expect.poll(()=>service.detail(task.id).events.some(e=>e.kind==='text')).toBe(true)
  await service.cancel(task.id);await settled(task.id)
  expect(service.detail(task.id).task.status).toBe('cancelled')
  expect(service.detail(task.id).task.phase).toBe('cancelled')
})

it('treats a task whose session settled itself after answering as replied too',async()=>{
  // Codex 的形状:回合结束、没有命令在跑,运行时自行收尾 → completed。主人眼里同样是「已答复」。
  wire({async spawn(){return{async *dispatch(){yield {kind:'text',text:'做完了。'} as AgentEvent;yield result},async close(){}}}})
  const task=service.create({path:project,providerId:'claude',text:'做一件事'})
  await settled(task.id)
  expect(service.detail(task.id).task.status).toBe('completed')
  expect(service.detail(task.id).task.phase).toBe('replied')
})
