import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {mkdtempSync,mkdirSync,realpathSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {openDb,type Db} from '../../lib/db'
import {createProviderRegistry} from '../provider-registry'
import type {AgentProvider} from '../agent-provider'
import type {NetworkGate} from '../../lib/network-gate'
import {makeWorkbenchStore} from './store'
import {makeWorkbenchService,type WorkbenchService} from './service'
import {MANAGED_NATIVE_CAPABILITIES} from './executor-capabilities'
import {removeTempDir} from '../../lib/test-temp'

// 网络闸门(2026-10-02):工作台在起执行者 / 投补充之前问一次;不安全就不 spawn。
let root:string,project:string,db:Db,service:WorkbenchService
const net={safe:true}
const gate:NetworkGate={check:async()=>({safe:net.safe,source:'bx',detail:net.safe?'bx 保护中':'bx 未保护'})}
function gateOpen(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return{promise,resolve}}
async function settled(id:string){await expect.poll(()=>service.detail(id).task.status).not.toMatch(/^(queued|running|cancelling)$/)}
function setup(provider:AgentProvider){
  const registry=createProviderRegistry({networkGate:gate})
  registry.register('claude',provider,{displayName:'claude',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  service=makeWorkbenchService({store:makeWorkbenchStore(db),registry,stateDir:root,ownerChatId:()=>null,networkGate:gate})
}
beforeEach(()=>{net.safe=true;root=realpathSync(mkdtempSync(join(tmpdir(),'cc-wb-netgate-')));project=join(root,'project');mkdirSync(project);db=openDb({path:join(root,'state.db')})})
afterEach(async()=>{await service?.shutdown();db.close();removeTempDir(root)})

it('unsafe → the executor is never spawned; task fails with network_unprotected and an honest event',async()=>{
  const spawn=vi.fn(async()=>({async *dispatch(){yield {kind:'result' as const,sessionId:'s',numTurns:1,durationMs:1}},async close(){}}))
  setup({spawn} as unknown as AgentProvider)
  net.safe=false
  const task=service.create({path:project,providerId:'claude',text:'do it'});await settled(task.id)
  expect(spawn).not.toHaveBeenCalled()
  const d=service.detail(task.id)
  expect(d.task.status).toBe('failed')
  expect(d.task.error).toBe('network_unprotected')
  expect(JSON.stringify(d)).toContain('网络未受保护')
})

it('unsafe → a supplement to a live run is refused (network_unprotected), nothing delivered',async()=>{
  const hold=gateOpen()
  const spawn=vi.fn(async()=>({async *dispatch(){yield {kind:'init' as const,sessionId:'s'};await hold.promise;yield {kind:'result' as const,sessionId:'s',numTurns:1,durationMs:1}},async close(){}}))
  setup({spawn} as unknown as AgentProvider)
  const task=service.create({path:project,providerId:'claude',text:'start'})
  await expect.poll(()=>service.detail(task.id).runId).toBeTruthy()
  net.safe=false
  await expect(service.submitInput(task.id,{runId:service.detail(task.id).runId!,requestId:randomUUID(),text:'more'})).rejects.toThrow('network_unprotected')
  hold.resolve();await settled(task.id)
})

it('pauseForNetwork stops a running executor and records why',async()=>{
  const hold=gateOpen()
  setup({async spawn(){return{async *dispatch(){yield {kind:'init' as const,sessionId:'s'};await hold.promise;yield {kind:'result' as const,sessionId:'s',numTurns:1,durationMs:1}},async close(){hold.resolve()},async cancel(){hold.resolve()}}}} as unknown as AgentProvider)
  const task=service.create({path:project,providerId:'claude',text:'start'})
  await expect.poll(()=>service.detail(task.id).task.status).toBe('running')
  expect(service.pauseForNetwork('网络未受保护(bx 未连上),CC 先暂停，恢复后再试。已停止本轮。')).toBe(1)
  await settled(task.id)
  expect(service.detail(task.id).task.status).toBe('cancelled')
  expect(JSON.stringify(service.detail(task.id))).toContain('已停止本轮')
})

// 守护 v2:按执行者 + 这一轮的模型分类;不需要保护的执行者(Cursor auto)网络不安全时照常起、永远不停。
function setupCursor(provider:AgentProvider){
  const registry=createProviderRegistry({networkGate:gate})
  registry.register('cursor',provider,{displayName:'cursor',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  service=makeWorkbenchService({store:makeWorkbenchStore(db),registry,stateDir:root,ownerChatId:()=>null,networkGate:gate})
}

it('unsafe → a Cursor(auto) executor still starts (not protected); the signal decides nothing for it',async()=>{
  const spawn=vi.fn(async()=>({async *dispatch(){yield {kind:'result' as const,sessionId:'s',numTurns:1,durationMs:1}},async close(){}}))
  setupCursor({spawn,callTarget:()=>({provider:'cursor',model:'auto'})} as unknown as AgentProvider)
  net.safe=false
  const task=service.create({path:project,providerId:'cursor',text:'do it'});await settled(task.id)
  expect(spawn).toHaveBeenCalledTimes(1)
  expect(service.detail(task.id).task.error).not.toBe('network_unprotected')
})

it('pauseForNetwork(select) only stops runs the selector marks protected; unprotected runs keep going',async()=>{
  const hold=gateOpen()
  setupCursor({async spawn(){return{async *dispatch(){yield {kind:'init' as const,sessionId:'s'};await hold.promise;yield {kind:'result' as const,sessionId:'s',numTurns:1,durationMs:1}},async close(){hold.resolve()},async cancel(){hold.resolve()}}},callTarget:()=>({provider:'cursor',model:'auto'})} as unknown as AgentProvider)
  const task=service.create({path:project,providerId:'cursor',text:'start'})
  await expect.poll(()=>service.detail(task.id).task.status).toBe('running')
  const seen:Array<{providerId:string;model:string|null}>=[]
  expect(service.pauseForNetwork(run=>{seen.push(run);return null})).toBe(0)
  expect(seen).toEqual([expect.objectContaining({providerId:'cursor',model:null,target:expect.objectContaining({provider:'cursor'})})])
  expect(service.detail(task.id).task.status).toBe('running')
  hold.resolve();await settled(task.id)
})

// 评审 #193 P1-1:续接 / 补充 / 起步按**会话实际在用**的目标判,不按任务记录的模型(或此刻的配置)判。
// Cursor 工作台执行者不钉模型,实际模型是 cursor-agent 起会话时报上来的那个(ACP configOptions.currentValue)。
function cursorExecutor(actualModel:string,hold?:Promise<void>){
  const dispatched=vi.fn()
  const spawn=vi.fn(async()=>({
    async *dispatch(){dispatched();yield {kind:'init' as const,sessionId:'s'};if(hold)await hold;yield {kind:'result' as const,sessionId:'s',numTurns:1,durationMs:1}},
    async close(){},async cancel(){},
    callTarget:()=>({provider:'cursor',model:actualModel}),
  }))
  // 起会话本身不发模型请求(ACP session/new);这一轮真正用什么模型要等会话起来才知道。
  const provider={spawn,callTarget:(kind:string)=>kind==='spawn'?{provider:'cursor',purpose:'setup' as const}:null} as unknown as AgentProvider
  return {provider,spawn,dispatched}
}

it('review #193: a Cursor run whose live session is on a Claude model → supplement refused while unsafe, though the task never pinned a model',async()=>{
  const hold=gateOpen()
  const {provider}=cursorExecutor('claude-opus-5[thinking=true]',hold.promise)
  setupCursor(provider)
  const task=service.create({path:project,providerId:'cursor',text:'start'})
  await expect.poll(()=>service.detail(task.id).runId).toBeTruthy()
  net.safe=false
  await expect(service.submitInput(task.id,{runId:service.detail(task.id).runId!,requestId:randomUUID(),text:'more'})).rejects.toThrow('network_unprotected')
  hold.resolve();await settled(task.id)
})

it('review #193: unsafe + a Cursor executor that comes up on a Claude model → no turn is sent; task fails network_unprotected',async()=>{
  const {provider,dispatched}=cursorExecutor('claude-opus-5[thinking=true]')
  setupCursor(provider)
  net.safe=false
  const task=service.create({path:project,providerId:'cursor',text:'do it'});await settled(task.id)
  expect(dispatched).not.toHaveBeenCalled()
  expect(service.detail(task.id).task.error).toBe('network_unprotected')
})

it('review #193: unsafe + a Cursor executor that comes up on Auto → runs normally',async()=>{
  const {provider,dispatched}=cursorExecutor('default[]')
  setupCursor(provider)
  net.safe=false
  const task=service.create({path:project,providerId:'cursor',text:'do it'});await settled(task.id)
  expect(dispatched).toHaveBeenCalledTimes(1)
  expect(service.detail(task.id).task.error).not.toBe('network_unprotected')
})

it('review #193: pauseForNetwork hands the selector the live session target',async()=>{
  const hold=gateOpen()
  const {provider}=cursorExecutor('gpt-5.5[context=272k]',hold.promise)
  setupCursor(provider)
  const task=service.create({path:project,providerId:'cursor',text:'start'})
  await expect.poll(()=>service.detail(task.id).task.status).toBe('running')
  const seen:unknown[]=[]
  service.pauseForNetwork(run=>{seen.push(run);return null})
  expect(seen).toEqual([expect.objectContaining({providerId:'cursor',target:expect.objectContaining({provider:'cursor',model:'gpt-5.5[context=272k]'})})])
  hold.resolve();await settled(task.id)
})
