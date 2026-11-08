import {afterEach,beforeEach,expect,it} from 'vitest'
import {mkdirSync,mkdtempSync,realpathSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {openDb,type Db} from '../../lib/db'
import {removeTempDir} from '../../lib/test-temp'
import {createProviderRegistry} from '../../app/provider-registry'
import {makeWorkbenchStore} from '../../adapters/store/workbench/store'
import {makeWorkbenchService,type WorkbenchService} from './service'
import {MANAGED_NATIVE_CAPABILITIES} from '../../domain/workbench/executor-capabilities'

// 每件事花了多少额度(v82):执行者在 result 上带的用量落一行,详情里给合计;不报的那家就是 null(「这家不报」)。
let area:string,project:string,db:Db,service:WorkbenchService,store:ReturnType<typeof makeWorkbenchStore>
beforeEach(()=>{area=realpathSync(mkdtempSync(join(tmpdir(),'cc-usage-')));project=join(area,'project');mkdirSync(project);db=openDb({path:join(area,'state.db')})
  const registry=createProviderRegistry()
  registry.register('claude',{async spawn(){return{async *dispatch(){yield{kind:'text' as const,text:'好了'};yield{kind:'result' as const,sessionId:'s',numTurns:1,durationMs:3,usage:{input:120,output:30,cacheRead:900}}},async close(){}}}},{displayName:'Claude',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  registry.register('codex',{async spawn(){return{async *dispatch(){yield{kind:'text' as const,text:'好了'};yield{kind:'result' as const,sessionId:'s',numTurns:1,durationMs:3}},async close(){}}}},{displayName:'Codex',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  store=makeWorkbenchStore(db);service=makeWorkbenchService({store,registry,stateDir:area,ownerChatId:()=>'owner'})})
afterEach(async()=>{await service.shutdown();db.close();removeTempDir(area)})
const settled=async(id:string)=>{await expect.poll(()=>service.detail(id).task.status).toBe('completed')}

it('records the reported usage per turn and shows a per-task total in detail',async()=>{
  const t=service.create({path:project,providerId:'claude',text:'x'})
  await settled(t.id)
  expect(service.detail(t.id).task.usage).toEqual({turns:1,input:120,output:30,cacheRead:900,cacheWrite:null,reasoning:null,costUsd:null})
})
it('an executor that reports nothing ⇒ no usage on the task (not zeros)',async()=>{
  const t=service.create({path:project,providerId:'codex',text:'x'})
  await settled(t.id)
  expect(service.detail(t.id).task.usage).toBeUndefined()
})

// 这件事的轮(M2b):接受这条 run 时开第一轮,执行者回应(result)收这一轮、带它报的用量与原生会话;run 收尾落这件事的结局。
const turns=(id:string)=>db.query('SELECT run_id AS runId,executor,status,usage_json AS usage,native_session_id AS session FROM matter_turns WHERE matter_id=? ORDER BY seq').all(id)
const state=(id:string)=>db.query<{state:string},[string]>('SELECT state FROM matters WHERE id=?').get(id)!.state
it('一次 run 记成这件事的一轮:result 收轮带用量和原生会话,做完 ⇒ done',async()=>{
  const t=service.create({path:project,providerId:'claude',text:'x'})
  await settled(t.id)
  const runId=service.detail(t.id).lastExecution!.runId
  expect(turns(t.id)).toEqual([{runId,executor:'claude',status:'completed',usage:'{"input":120,"output":30,"cacheRead":900}',session:'s'}])
  expect(state(t.id)).toBe('done')
})
it('没回应就断了 ⇒ 这一轮记失败,这件事 failed',async()=>{
  const registry=createProviderRegistry()
  registry.register('claude',{async spawn(){return{async *dispatch(){yield{kind:'text' as const,text:'做到一半'}},async close(){}}}},{displayName:'Claude',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  await service.shutdown()
  service=makeWorkbenchService({store,registry,stateDir:area,ownerChatId:()=>'owner'})
  const t=service.create({path:project,providerId:'claude',text:'x'})
  await expect.poll(()=>service.detail(t.id).task.status).toBe('failed')
  expect(turns(t.id)).toEqual([{runId:service.detail(t.id).lastExecution!.runId,executor:'claude',status:'failed',usage:null,session:null}])
  expect(state(t.id)).toBe('failed')
})
it('开机 recover:上一次没收尾的轮记中断,这件事回到主人手里',()=>{
  const t=store.create({title:'t',path:project,providerId:'claude',ownerChatId:'owner'})
  store.execution.accept(t.id,'r1',{defaults:'provider',model:null,reasoningEffort:null})
  store.update(t.id,'running')
  expect(state(t.id)).toBe('working')
  store.recover()
  expect(db.query('SELECT status,error_code AS code FROM matter_turns WHERE matter_id=?').all(t.id)).toEqual([{status:'interrupted',code:'daemon_restarted'}])
  expect(state(t.id)).toBe('open')
})
it('run 收尾时轮都收了(常驻会话答完才关)⇒ 直接落 run 的结局;已经收了的轮不改',()=>{
  const t=store.create({title:'t',path:project,providerId:'claude',ownerChatId:'owner'})
  const first=store.execution.accept(t.id,'r1',{defaults:'provider',model:null,reasoningEffort:null})!
  store.execution.endTurn(first)
  store.execution.nextTurn(t.id,'r1')
  store.execution.endRun(t.id,'r1','completed')
  expect(state(t.id)).toBe('done')
  store.execution.endRun(t.id,'r1','failed')
  expect(state(t.id)).toBe('failed')
  expect(db.query('SELECT status FROM matter_turns WHERE matter_id=? ORDER BY seq').all(t.id)).toEqual([{status:'completed'},{status:'completed'}])
})
it('常驻会话答完还开着(轮已收)时重启:没有开着的轮,这件事照样回到 open(v94 搬来的在跑任务也是这样)',()=>{
  const t=store.create({title:'t',path:project,providerId:'claude',ownerChatId:'owner'})
  store.execution.endTurn(store.execution.accept(t.id,'r1',{defaults:'provider',model:null,reasoningEffort:null})!)
  store.update(t.id,'running')
  db.query("UPDATE matters SET state='working' WHERE id=?").run(t.id)
  store.recover()
  expect(state(t.id)).toBe('open')
})
it('同一条 run 重放接受:还回它开着的那一轮,不丢、不另开(Codex 评审 P2)',()=>{
  const t=store.create({title:'t',path:project,providerId:'claude',ownerChatId:'owner'})
  const choice={defaults:'provider',model:null,reasoningEffort:null} as const
  const first=store.execution.accept(t.id,'r1',choice)
  expect(store.execution.accept(t.id,'r1',choice)).toBe(first)
  store.execution.endTurn(first!)
  expect(store.execution.accept(t.id,'r1',choice)).toBeNull()
  expect(state(t.id)).toBe('open')
})
