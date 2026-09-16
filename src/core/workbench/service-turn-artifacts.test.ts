import {afterEach,beforeEach,expect,it} from 'vitest'
import {mkdtempSync,mkdirSync,realpathSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {openDb,type Db} from '../../lib/db'
import {AsyncQueue} from '../async-queue'
import {createProviderRegistry} from '../provider-registry'
import type {AgentEvent,AgentProvider,AgentRuntimeSnapshot,AgentSession,AgentWorkbenchRuntime} from '../agent-provider'
import {makeWorkbenchStore} from './store'
import {makeWorkbenchService,type WorkbenchService} from './service'
import {MANAGED_NATIVE_CAPABILITIES} from './executor-capabilities'

/**
 * 真机 2026-09-15:Claude 答完、写好文件、`foreground` 回到 `idle`,但会话为续接
 * 保留,所以这一条 run 不会结算 —— 而成果登记只在结算时发生。结果是文件躺在
 * `.cc-workbench/<task>/` 里,任务详情的成果列表却是空的,主人必须先「取消」
 * 才看得见自己刚拿到的东西。回合有终点(SDK 的 `result` 事件),登记就该在那时发生。
 */
class TurnRuntime {
  queue=new AsyncQueue<AgentEvent>()
  state:AgentRuntimeSnapshot={retained:true,foreground:'idle',backgroundCount:0,input:'send'}
  subscribed=false
  runtime:AgentWorkbenchRuntime={
    events:{[Symbol.asyncIterator]:()=>{this.subscribed=true;return this.queue.iterable()[Symbol.asyncIterator]()}},
    start:()=>{
      if(!this.subscribed)throw Error('runtime_start_without_consumer')
      this.queue.push({kind:'init',sessionId:'turn-session'})
      this.queue.push({kind:'text',itemId:'first',text:'已完成,成果已写入。'})
    },
    submit:async()=>{},
    snapshot:()=>this.state,
  }
  session:AgentSession={
    workbenchRuntime:this.runtime,
    async *dispatch(){},
    close:async()=>{this.queue.end()},
  }
}

let area:string,project:string,db:Db,service:WorkbenchService
beforeEach(()=>{
  area=realpathSync(mkdtempSync(join(tmpdir(),'cc-turn-artifacts-')))
  project=join(area,'project');mkdirSync(project)
  db=openDb({path:join(area,'state.db')})
})
afterEach(async()=>{await service?.shutdown();db.close();rmSync(area,{recursive:true,force:true})})

it('registers a finished turn’s artifacts while the session is still retained',async()=>{
  const owned=new TurnRuntime()
  const registry=createProviderRegistry()
  const provider:AgentProvider={async spawn(){return owned.session}}
  registry.register('claude',provider,{displayName:'Claude',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  service=makeWorkbenchService({store:makeWorkbenchStore(db),registry,stateDir:area,ownerChatId:()=>null})

  const task=service.create({path:project,providerId:'claude',text:'写一份报告'})
  await expect.poll(()=>service.detail(task.id).events.some(event=>event.kind==='text')).toBe(true)

  // 执行者把成果写进本任务的成果目录,然后这一轮结束(result),但会话保留。
  const output=join(project,'.cc-workbench',task.id)
  mkdirSync(output,{recursive:true})
  writeFileSync(join(output,'report.md'),'# 报告\n结论如上。\n')
  owned.queue.push({kind:'result',sessionId:'turn-session',numTurns:1,durationMs:1})

  await expect.poll(()=>service.detail(task.id).artifacts.map(artifact=>artifact.name)).toEqual(['report.md'])
  // 关键:成果出现时任务并没有结束 —— 主人不必先取消才能看见。
  expect(service.detail(task.id).task.status).toBe('running')
  expect(service.detail(task.id).task.runtime).toMatchObject({retained:true,foreground:'idle'})
})

it('does not repeat the same collection warning on every later turn',async()=>{
  // 评审(2026-09-16):每回合结束都重扫成果目录,一个不收集的文件会在每一轮各记一条
  // 一模一样的「此文件类型不收集」—— 十轮之后任务记录里就是十条。同一条警告只记一次。
  const owned=new TurnRuntime()
  const registry=createProviderRegistry()
  registry.register('claude',{async spawn(){return owned.session}},{displayName:'Claude',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  service=makeWorkbenchService({store:makeWorkbenchStore(db),registry,stateDir:area,ownerChatId:()=>null})
  const task=service.create({path:project,providerId:'claude',text:'写一份报告'})
  await expect.poll(()=>service.detail(task.id).events.some(event=>event.kind==='text')).toBe(true)
  const output=join(project,'.cc-workbench',task.id)
  mkdirSync(output,{recursive:true})
  writeFileSync(join(output,'model.blob'),'binary-ish')
  const warnings=()=>service.detail(task.id).events.filter(e=>e.kind==='system'&&e.text.includes('此文件类型不收集')).length
  owned.queue.push({kind:'result',sessionId:'turn-session',numTurns:1,durationMs:1})
  await expect.poll(warnings).toBe(1)
  owned.queue.push({kind:'result',sessionId:'turn-session',numTurns:2,durationMs:1})
  owned.queue.push({kind:'result',sessionId:'turn-session',numTurns:3,durationMs:1})
  // 最后一轮结算(取消)也再收一次 —— 仍然只该有那一条。
  await new Promise(r=>setTimeout(r,80))
  await service.cancel(task.id)
  await expect.poll(()=>service.detail(task.id).task.status).not.toMatch(/^(running|cancelling)$/)
  expect(warnings()).toBe(1)
})
