import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {mkdtempSync,mkdirSync,realpathSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {openDb,type Db} from '../../lib/db'
import {createProviderRegistry} from '../provider-registry'
import type {AgentProvider,AgentSessionSuspension} from '../agent-provider'
import type {NetworkGate} from '../../lib/network-gate'
import {makeWorkbenchStore} from './store'
import {makeWorkbenchService,type WorkbenchService} from './service'
import {MANAGED_NATIVE_CAPABILITIES} from './executor-capabilities'
import {removeTempDir} from '../../lib/test-temp'

// 网络守护「暂停在跑的任务」(主人 2026-10-03):冻住(SIGSTOP)而不是停;冻住期间 daemon 侧为这条
// run 起的计时器(回合看门狗、批准期限、空闲收工)一律不走;放开后接着跑;到顶 / 主人取消 ⇒ 不放开直接杀。
let root:string,project:string,db:Db,service:WorkbenchService
const gate:NetworkGate={check:async()=>({safe:true,source:'probe',detail:'探测可达'})}
function gateOpen(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return{promise,resolve}}
async function settled(id:string){await expect.poll(()=>service.detail(id).task.status,{timeout:5_000}).not.toMatch(/^(queued|running|cancelling)$/)}
const PROTECTED=(_run:{target:unknown})=>'VPN 探测连续两次失败，这个任务用到 Claude。'

function suspendable(opts:{suspendResult?:boolean}={}){
  const calls:string[]=[]
  const hold=gateOpen()
  const suspension:AgentSessionSuspension={suspend:vi.fn(()=>{calls.push('suspend');return opts.suspendResult??true}),resume:vi.fn(()=>{calls.push('resume')}),terminate:vi.fn(()=>{calls.push('terminate');hold.resolve()})}
  const provider={async spawn(){return{
    async *dispatch(){yield {kind:'init' as const,sessionId:'s'};await hold.promise;yield {kind:'text' as const,text:'RECOVERED'};yield {kind:'result' as const,sessionId:'s',numTurns:1,durationMs:1}},
    async close(){hold.resolve()},async cancel(){hold.resolve()},suspension,
    callTarget:()=>({provider:'claude',model:'claude-opus-5'}),
  }}} as unknown as AgentProvider
  return {provider,suspension,calls,hold}
}
function setup(provider:AgentProvider,extra:Record<string,unknown>={}){
  const registry=createProviderRegistry({networkGate:gate})
  registry.register('claude',provider,{displayName:'claude',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  service=makeWorkbenchService({store:makeWorkbenchStore(db),registry,stateDir:root,ownerChatId:()=>null,networkGate:gate,...extra})
}
beforeEach(()=>{root=realpathSync(mkdtempSync(join(tmpdir(),'cc-wb-netsuspend-')));project=join(root,'project');mkdirSync(project);db=openDb({path:join(root,'state.db')})})
afterEach(async()=>{await service?.shutdown();db.close();removeTempDir(root)})

it('suspend freezes a protected run instead of stopping it; the turn watchdog does not fire while frozen; resume lets it finish',async()=>{
  const {provider,suspension,calls,hold}=suspendable()
  setup(provider,{timeoutMs:60})                     // 60ms 的回合看门狗
  const task=service.create({path:project,providerId:'claude',text:'start'})
  await expect.poll(()=>service.detail(task.id).task.status).toBe('running')
  await expect.poll(()=>service.detail(task.id).runId).toBeTruthy()
  expect(service.suspendForNetwork(PROTECTED)).toEqual({suspended:1,stopped:0})
  expect(suspension.suspend).toHaveBeenCalledTimes(1)
  expect(service.networkSuspended()).toEqual([expect.objectContaining({taskId:task.id,providerId:'claude'})])
  expect(service.detail(task.id).task.networkSuspended).toEqual({since:expect.any(Number)})
  expect(JSON.stringify(service.detail(task.id).events)).toContain('已暂停(网络未受保护)')
  await new Promise(resolve=>setTimeout(resolve,300))  // 五倍于看门狗
  expect(service.detail(task.id).task.status).toBe('running')
  expect(service.detail(task.id).task.error).toBeNull()
  expect(service.resumeFromNetwork()).toBe(1)
  expect(calls).toEqual(['suspend','resume'])
  expect(service.networkSuspended()).toEqual([])
  hold.resolve();await settled(task.id)
  expect(service.detail(task.id).task.status).toBe('completed')
  expect(JSON.stringify(service.detail(task.id).events)).toContain('网络恢复，已继续')
})

it('control: without suspension the same 60ms watchdog fails the turn (turn_timeout)',async()=>{
  const {provider}=suspendable()
  setup(provider,{timeoutMs:60})
  const task=service.create({path:project,providerId:'claude',text:'start'})
  await settled(task.id)
  expect(service.detail(task.id).task.error).toBe('turn_timeout')
})

it('unprotected runs (selector → null) are never touched',async()=>{
  const {provider,suspension,hold}=suspendable()
  setup(provider)
  const task=service.create({path:project,providerId:'claude',text:'start'})
  await expect.poll(()=>service.detail(task.id).task.status).toBe('running')
  expect(service.suspendForNetwork(()=>null)).toEqual({suspended:0,stopped:0})
  expect(suspension.suspend).not.toHaveBeenCalled()
  hold.resolve();await settled(task.id)
  expect(service.detail(task.id).task.status).toBe('completed')
})

it('an executor that cannot be frozen (no suspension / suspend() false) falls back to the old graceful stop',async()=>{
  const {provider}=suspendable({suspendResult:false})
  setup(provider)
  const task=service.create({path:project,providerId:'claude',text:'start'})
  await expect.poll(()=>service.detail(task.id).task.status).toBe('running')
  expect(service.suspendForNetwork(PROTECTED)).toEqual({suspended:0,stopped:1})
  await settled(task.id)
  expect(service.detail(task.id).task.status).toBe('cancelled')
  expect(JSON.stringify(service.detail(task.id).events)).toContain('已停止本轮')
})

it('cap reached: stopSuspendedForNetwork terminates the frozen tree without ever resuming it; task stops with the owner sentence',async()=>{
  const {provider,calls}=suspendable()
  setup(provider)
  const task=service.create({path:project,providerId:'claude',text:'start'})
  await expect.poll(()=>service.detail(task.id).task.status).toBe('running')
  service.suspendForNetwork(PROTECTED)
  expect(service.stopSuspendedForNetwork('网络一直没恢复，任务已停止，可以接着做')).toBe(1)
  await settled(task.id)
  expect(calls).toEqual(['suspend','terminate'])
  expect(service.detail(task.id).task.status).toBe('cancelled')
  expect(JSON.stringify(service.detail(task.id).events)).toContain('网络一直没恢复，任务已停止，可以接着做')
  expect(service.networkSuspended()).toEqual([])
})

it('owner cancels a frozen run → terminate (never SIGCONT first)',async()=>{
  const {provider,calls}=suspendable()
  setup(provider)
  const task=service.create({path:project,providerId:'claude',text:'start'})
  await expect.poll(()=>service.detail(task.id).task.status).toBe('running')
  service.suspendForNetwork(PROTECTED)
  await service.cancel(task.id)
  await settled(task.id)
  expect(calls).toEqual(['suspend','terminate'])
})

it('a pending permission does not expire while frozen (approval deadline paused)',async()=>{
  const hold=gateOpen()
  let decision:Promise<boolean>|undefined
  const suspension:AgentSessionSuspension={suspend:()=>true,resume:()=>{},terminate:()=>hold.resolve()}
  const provider={async spawn(_p:unknown,ctx:{requestPermission:(r:{tool:string;description:string})=>Promise<boolean>}){return{
    async *dispatch(){yield {kind:'init' as const,sessionId:'s'};decision=ctx.requestPermission({tool:'Bash',description:'ls'});await hold.promise;yield {kind:'result' as const,sessionId:'s',numTurns:1,durationMs:1}},
    async close(){hold.resolve()},async cancel(){hold.resolve()},suspension,
  }}} as unknown as AgentProvider
  setup(provider,{permissionTimeoutMs:80})
  const task=service.create({path:project,providerId:'claude',text:'start'})
  await expect.poll(()=>service.detail(task.id).permissions.length).toBe(1)
  service.suspendForNetwork(PROTECTED)
  await new Promise(resolve=>setTimeout(resolve,250))
  expect(service.detail(task.id).permissions.length).toBe(1)   // 冻住期间没过期
  service.resumeFromNetwork()
  expect(await decision).toBe(false)                            // 放开后按剩下的时间照常到期
  hold.resolve();await settled(task.id)
})
