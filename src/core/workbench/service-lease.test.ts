import {afterEach,beforeEach,expect,it} from 'vitest'
import {mkdtempSync,mkdirSync,realpathSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {openDb,type Db} from '../../lib/db'
import {AsyncQueue} from '../async-queue'
import {createProviderRegistry} from '../provider-registry'
import type {AgentEvent,AgentRuntimeSnapshot,AgentSession,AgentWorkbenchRuntime} from '../agent-provider'
import {makeWorkbenchStore} from './store'
import {makeWorkbenchService,type WorkbenchService} from './service'
import {MANAGED_NATIVE_CAPABILITIES} from './executor-capabilities'

/**
 * 文件夹是一份租约(Orca 的思路):谁在写谁持有。此前 Claude 答完后会话为续接保留,
 * 租约也跟着一直握着 —— 同一文件夹的下一个任务永久排队,主人只能先「取消」一件
 * 已经做成的事来疏通(2026-09-15 真机)。现在:回合答复即释放;主人回来续接时再申请,
 * 若文件夹正被别的任务占用则明确拒绝(workbench_busy),而不是悄悄并写。
 */
const result:AgentEvent={kind:'result',sessionId:'lease-session',numTurns:1,durationMs:1}
class TurnRuntime {
  queue=new AsyncQueue<AgentEvent>()
  state:AgentRuntimeSnapshot={retained:true,foreground:'running',backgroundCount:0,input:'send'}
  subscribed=false; submitted:string[]=[]
  runtime:AgentWorkbenchRuntime={
    events:{[Symbol.asyncIterator]:()=>{this.subscribed=true;return this.queue.iterable()[Symbol.asyncIterator]()}},
    start:()=>{if(!this.subscribed)throw Error('runtime_start_without_consumer');this.queue.push({kind:'init',sessionId:'lease-session'});this.queue.push({kind:'text',itemId:`t${this.submitted.length}`,text:'正在做。'})},
    submit:async(_id,text)=>{this.submitted.push(text);this.state={...this.state,foreground:'running'};this.queue.push({kind:'text',itemId:`t${this.submitted.length}`,text:'接着做。'})},
    snapshot:()=>this.state,
  }
  session:AgentSession={workbenchRuntime:this.runtime,async *dispatch(){},close:async()=>{this.queue.end()}}
  finishTurn(){this.state={...this.state,foreground:'idle'};this.queue.push(result)}
}

let area:string,project:string,db:Db,service:WorkbenchService,runtimes:TurnRuntime[]
beforeEach(()=>{
  area=realpathSync(mkdtempSync(join(tmpdir(),'cc-lease-')));project=join(area,'project');mkdirSync(project);db=openDb({path:join(area,'state.db')})
  runtimes=[];const registry=createProviderRegistry()
  registry.register('claude',{async spawn(){const r=new TurnRuntime();runtimes.push(r);return r.session}},{displayName:'Claude',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  service=makeWorkbenchService({store:makeWorkbenchStore(db),registry,stateDir:area,ownerChatId:()=>null})
})
afterEach(async()=>{await service?.shutdown();db.close();rmSync(area,{recursive:true,force:true})})
const create=(text:string)=>service.create({path:project,providerId:'claude',text})
const phase=(id:string)=>service.detail(id).task.phase
const status=(id:string)=>service.detail(id).task.status

it('releases the folder once the turn is answered so a queued task in the same folder starts',async()=>{
  const a=create('第一件');await expect.poll(()=>service.detail(a.id).events.some(e=>e.kind==='text')).toBe(true)
  const b=create('第二件')
  await expect.poll(()=>service.detail(b.id).task.waitingFor?.taskId).toBe(a.id)
  runtimes[0]!.finishTurn()
  await expect.poll(()=>phase(a.id)).toBe('replied')
  await expect.poll(()=>status(b.id)).toBe('running')
  // A 并没有被结束:会话仍在,只是不再占着文件夹。
  expect(status(a.id)).toBe('running');expect(service.detail(a.id).task.runtime).toMatchObject({retained:true,foreground:'idle'})
})

it('refuses to continue a replied task while another task holds its folder, then lets it continue',async()=>{
  const a=create('第一件');await expect.poll(()=>service.detail(a.id).events.some(e=>e.kind==='text')).toBe(true)
  runtimes[0]!.finishTurn();await expect.poll(()=>phase(a.id)).toBe('replied')
  const b=create('第二件');await expect.poll(()=>status(b.id)).toBe('running')
  const runId=service.detail(a.id).runId!
  await expect(service.submitInput(a.id,{runId,requestId:randomUUID(),text:'再补一句'})).rejects.toThrow('workbench_busy')
  expect(runtimes[0]!.submitted).toEqual([])
  runtimes[1]!.finishTurn();await expect.poll(()=>phase(b.id)).toBe('replied')
  await service.submitInput(a.id,{runId,requestId:randomUUID(),text:'再补一句'})
  await expect.poll(()=>runtimes[0]!.submitted).toEqual(['再补一句'])
  await expect.poll(()=>phase(a.id)).toBe('working')
  // A 重新持有租约:此时再来一件同文件夹的任务要排在 A 后面。
  const c=create('第三件')
  await expect.poll(()=>service.detail(c.id).task.waitingFor?.taskId).toBe(a.id)
})
