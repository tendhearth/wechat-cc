import {afterEach,beforeEach,expect,it} from 'vitest'
import {mkdirSync,mkdtempSync,realpathSync,rmSync} from 'node:fs'
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

/**
 * 工作台任务与 matter(事)一对一,id 相同(docs/cc-workbench.md「一件事」,2026-09-16)。
 * 任务的生命周期要同步到 matter:建 → open(并绑上主人的微信);拿到会话 id → 记会话;
 * 答复 → replied;结算 → done;归档 → archived。
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
let area:string,project:string,db:Db,service:WorkbenchService,matters:MatterStore,runtime:TurnRuntime
beforeEach(()=>{
  area=realpathSync(mkdtempSync(join(tmpdir(),'cc-service-matters-')));project=join(area,'project');mkdirSync(project)
  db=openDb({path:join(area,'state.db')});matters=makeMatterStore(db)
  const registry=createProviderRegistry();runtime=new TurnRuntime()
  registry.register('claude',{async spawn(){return runtime.session}},{displayName:'Claude',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  service=makeWorkbenchService({store:makeWorkbenchStore(db),registry,stateDir:area,ownerChatId:()=>'owner-chat',matters})
})
afterEach(async()=>{await service?.shutdown();db.close();removeTempDir(area);rmSync(area,{recursive:true,force:true})})

it('mirrors a task into a matter with the same id, then follows it through replied, done and archived',async()=>{
  const task=service.create({path:project,providerId:'claude',text:'整理周报'})
  const created=matters.get(task.id)
  expect(created).toMatchObject({id:task.id,kind:'task',title:task.title,projectPath:project,status:'open',ownerChatId:'owner-chat'})
  expect(matters.bindings(task.id).map(b=>[b.surface,b.surfaceKey])).toEqual([['wechat','owner-chat']])
  // 迁移里那一列也要跟上,存量任务靠回填,新任务靠这里。
  expect(db.query<{matter_id:string|null},[string]>('SELECT matter_id FROM workbench_tasks WHERE id=?').get(task.id)).toEqual({matter_id:task.id})

  await expect.poll(()=>matters.sessions(task.id)).toEqual([expect.objectContaining({providerId:'claude',sessionId:'native-1',role:'main'})])
  runtime.finishTurn()
  await expect.poll(()=>matters.get(task.id)?.status).toBe('replied')

  await service.cancel(task.id)
  await expect.poll(()=>service.detail(task.id).task.status).not.toMatch(/^(running|cancelling)$/)
  await expect.poll(()=>matters.get(task.id)?.status).toBe('done')

  service.setArchived(task.id,true)
  expect(matters.get(task.id)?.status).toBe('archived')
  service.setArchived(task.id,false)
  expect(matters.get(task.id)?.status).toBe('done')
})

it('works without a matter store (older wiring) — nothing else changes',async()=>{
  const registry=createProviderRegistry();const r=new TurnRuntime()
  registry.register('claude',{async spawn(){return r.session}},{displayName:'Claude',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  const plain=makeWorkbenchService({store:makeWorkbenchStore(db),registry,stateDir:area,ownerChatId:()=>null})
  try{
    const task=plain.create({path:project,providerId:'claude',text:'x'})
    expect(matters.get(task.id)).toBeNull()
  }finally{await plain.shutdown()}
})
