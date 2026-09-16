import {afterEach,beforeEach,expect,it} from 'vitest'
import {mkdtempSync,mkdirSync,realpathSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {openDb,type Db} from '../../lib/db'
import {AsyncQueue} from '../async-queue'
import {createProviderRegistry} from '../provider-registry'
import type {AgentEvent,AgentRuntimeSnapshot,AgentSession,AgentWorkbenchRuntime} from '../agent-provider'
import {makeWorkbenchStore} from './store'
import {makeWorkbenchService,type WorkbenchService} from './service'
import {MANAGED_NATIVE_CAPABILITIES} from './executor-capabilities'

/**
 * 真机 2026-09-16:Codex 额度耗尽,任务 failed,task.error 是一长串原文,微信通知正文空白,
 * 管家还接着往 Codex 送要求。这里要求:认出额度错误 → 任务错误码 provider_quota_exhausted
 * (事件里是能读懂的话)→ 服务登记这家耗尽 → 已订阅时通知带原因和"交给另一位继续?"。
 */
const CODEX_QUOTA="You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 10:00"
class FailingRuntime {
  queue=new AsyncQueue<AgentEvent>()
  state:AgentRuntimeSnapshot={retained:false,foreground:'running',backgroundCount:0,input:'send'}
  subscribed=false
  runtime:AgentWorkbenchRuntime={
    events:{[Symbol.asyncIterator]:()=>{this.subscribed=true;return this.queue.iterable()[Symbol.asyncIterator]()}},
    start:()=>{this.queue.push({kind:'init',sessionId:'s'});this.queue.push({kind:'error',message:CODEX_QUOTA});this.queue.end()},
    submit:async()=>{},
    snapshot:()=>this.state,
  }
  session:AgentSession={workbenchRuntime:this.runtime,async *dispatch(){},close:async()=>{}}
}
let area:string,project:string,db:Db,service:WorkbenchService,store:ReturnType<typeof makeWorkbenchStore>
beforeEach(()=>{area=realpathSync(mkdtempSync(join(tmpdir(),'cc-quota-')));project=join(area,'project');mkdirSync(project);db=openDb({path:join(area,'state.db')})
  const registry=createProviderRegistry()
  registry.register('codex',{async spawn(){return new FailingRuntime().session}},{displayName:'Codex',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  registry.register('claude',{async spawn(){return new FailingRuntime().session}},{displayName:'Claude',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  store=makeWorkbenchStore(db);service=makeWorkbenchService({store,registry,stateDir:area,ownerChatId:()=>'owner'})})
afterEach(async()=>{await service?.shutdown();db.close();rmSync(area,{recursive:true,force:true})})
const settled=async(id:string)=>{await expect.poll(()=>service.detail(id).task.status).not.toMatch(/^(running|queued|cancelling)$/)}

it('额度耗尽 ⇒ 任务 failed、错误码 provider_quota_exhausted、事件里是人话、服务登记这家耗尽',async()=>{
  const task=service.create({path:project,providerId:'codex',text:'读 DATA.md'})
  await settled(task.id)
  const d=service.detail(task.id)
  expect(d.task.status).toBe('failed')
  expect(d.task.error).toBe('provider_quota_exhausted')
  const errors=d.events.filter(e=>e.kind==='error').map(e=>e.text??'')
  expect(errors.some(t=>t.includes('额度'))).toBe(true)
  expect(service.providerQuota()).toMatchObject({codex:{kind:'quota',message:expect.stringContaining('usage limit')}})
  expect(service.providerQuota().claude).toBeUndefined()
  // 列表里的执行者项带上额度状态,桌面 / 管家都能看。
  const codex=service.list().providers.find(p=>p.id==='codex')!
  expect(codex.quota).toMatchObject({kind:'quota'})
})

it('已订阅时,失败通知带原因和"交给另一位继续?"',async()=>{
  const task=service.create({path:project,providerId:'codex',text:'读 DATA.md'})
  service.setWechatWatch(task.id,'acct',true)
  await settled(task.id)
  const notices=store.wechatNotifications.list(task.id)
  expect(notices).toHaveLength(1)
  expect(notices[0]!.kind).toBe('failed')
  expect(notices[0]!.text).toMatch(/额度/)
  expect(notices[0]!.text).toMatch(/交给 Claude 继续/)
})

it('评审 #5:额度错误到达时就登记,不等结算;之后任何成功回合即清除',async()=>{
  // 保留会话:先出一条额度错误事件,run 不结算;然后下一轮正常 result。
  const {AsyncQueue}=await import('../async-queue')
  const q=new AsyncQueue<AgentEvent>()
  let state:AgentRuntimeSnapshot={retained:true,foreground:'running',backgroundCount:0,input:'send'}
  const registry=createProviderRegistry()
  registry.register('codex',{async spawn(){return{workbenchRuntime:{events:{[Symbol.asyncIterator]:()=>q.iterable()[Symbol.asyncIterator]()},start:()=>{q.push({kind:'init',sessionId:'s'});q.push({kind:'error',message:'HTTP 429 Too Many Requests'})},submit:async()=>{},snapshot:()=>state},async *dispatch(){},close:async()=>{q.end()}}}},{displayName:'Codex',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  const svc=makeWorkbenchService({store:makeWorkbenchStore(db),registry,stateDir:area,ownerChatId:()=>'owner'})
  try{
    const task=svc.create({path:project,providerId:'codex',text:'x'})
    await expect.poll(()=>svc.quotaExhausted('codex')?.kind).toBe('rate_limit')
    expect(svc.detail(task.id).task.status).toBe('running')
    state={...state,foreground:'idle'};q.push({kind:'result',sessionId:'s',numTurns:1,durationMs:1})
    await expect.poll(()=>svc.quotaExhausted('codex')).toBeNull()
  }finally{await svc.shutdown()}
})
