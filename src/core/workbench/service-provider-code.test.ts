import {afterEach,beforeEach,expect,it} from 'vitest'
import {mkdtempSync,mkdirSync,realpathSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {openDb,type Db} from '../../lib/db'
import {AsyncQueue} from '../async-queue'
import {createProviderRegistry} from '../provider-registry'
import type {AgentEvent,AgentRuntimeSnapshot,AgentSession} from '../agent-provider'
import {makeWorkbenchStore} from './store'
import {makeWorkbenchService,type WorkbenchService} from './service'
import {MANAGED_NATIVE_CAPABILITIES} from './executor-capabilities'
import {removeTempDir} from '../../lib/test-temp'
import {errorWithProviderCode} from '../../lib/provider-error-code'

/**
 * arch backlog #4 第 2 步 · 工作台:任务失败带 provider 码 ⇒ 稳定错误码 + 一句老实的原因,
 * 桌面(事件)、手机(task.error)、微信(完成通知)看到的是「认证 / 网络 / 额度」,而不是
 * 一串原文或笼统的「执行失败」。
 */
const failing=(event:AgentEvent):AgentSession=>{
  const q=new AsyncQueue<AgentEvent>(),state:AgentRuntimeSnapshot={retained:false,foreground:'running',backgroundCount:0,input:'send'}
  return{workbenchRuntime:{events:{[Symbol.asyncIterator]:()=>q.iterable()[Symbol.asyncIterator]()},start:()=>{q.push({kind:'init',sessionId:'s'});q.push(event);q.end()},submit:async()=>{},snapshot:()=>state},async *dispatch(){},close:async()=>{}}
}
let area:string,project:string,db:Db,service:WorkbenchService,store:ReturnType<typeof makeWorkbenchStore>,next:()=>Promise<AgentSession>
beforeEach(()=>{area=realpathSync(mkdtempSync(join(tmpdir(),'cc-pcode-')));project=join(area,'project');mkdirSync(project);db=openDb({path:join(area,'state.db')})
  const registry=createProviderRegistry()
  registry.register('codex',{spawn:()=>next()},{displayName:'Codex',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  registry.register('claude',{spawn:()=>next()},{displayName:'Claude',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  store=makeWorkbenchStore(db);service=makeWorkbenchService({store,registry,stateDir:area,ownerChatId:()=>'owner'})})
afterEach(async()=>{await service?.shutdown();db.close();removeTempDir(area)})
const settled=async(id:string)=>{await expect.poll(()=>service.detail(id).task.status).not.toMatch(/^(running|queued|cancelling)$/)}

it.each([
  ['network','Codex 连不上服务,60s 内没有恢复','provider_network',/网络问题/],
  ['auth_rejected','unexpected status 401 Unauthorized: Incorrect API key provided','provider_auth_rejected',/401\/403/],
  ['auth_failed','unexpected status 401 Unauthorized: Missing bearer or basic authentication in header','provider_auth_expired',/重新登录/],
  ['server_error','HTTP 524 (after 3 attempts): <html>','provider_server_error',/5xx/],
  ['quota','something only the code knows','provider_quota_exhausted',/额度/],
] as const)('error code %s ⇒ task.error %s, readable event, WeChat notice says why',async(code,message,taskError,reason)=>{
  next=async()=>failing({kind:'error',message,code})
  const task=service.create({path:project,providerId:'codex',text:'x'})
  service.setWechatWatch(task.id,'acct',true)
  await settled(task.id)
  const d=service.detail(task.id)
  expect(d.task.status).toBe('failed')
  expect(d.task.error).toBe(taskError)
  const errors=d.events.filter(e=>e.kind==='error').map(e=>e.text??'')
  expect(errors.some(t=>reason.test(t)&&t.includes(message.slice(0,20)))).toBe(true)
  const notices=store.wechatNotifications.list(task.id)
  expect(notices).toHaveLength(1)
  expect(notices[0]!.text).toMatch(reason)
})

it('red line A: auth_rejected never says 登录 in the event or the WeChat notice',async()=>{
  next=async()=>failing({kind:'error',message:'Failed to authenticate. API Error: 403 Request not allowed',code:'auth_rejected'})
  const task=service.create({path:project,providerId:'claude',text:'x'})
  service.setWechatWatch(task.id,'acct',true)
  await settled(task.id)
  const d=service.detail(task.id)
  expect(d.events.filter(e=>e.kind==='error').map(e=>e.text??'').join('\n')).not.toMatch(/登录|过期/)
  expect(store.wechatNotifications.list(task.id)[0]!.text).not.toMatch(/登录|过期/)
})

it('a spawn failure that carries a code (Cursor ACP setup) keeps its own known message; an unknown one gets the coded message',async()=>{
  next=async()=>{throw errorWithProviderCode('acp_auth_required','auth_failed')}
  const a=service.create({path:project,providerId:'codex',text:'x'})
  await settled(a.id)
  expect(service.detail(a.id).task.error).toBe('acp_auth_required')
  next=async()=>{throw errorWithProviderCode('something unmapped','network')}
  const b=service.create({path:project,providerId:'codex',text:'x'})
  await settled(b.id)
  expect(service.detail(b.id).task.error).toBe('provider_network')
})

it('no code ⇒ unchanged fallback (raw text, quota still recognised from the text)',async()=>{
  next=async()=>failing({kind:'error',message:'something odd happened'})
  const task=service.create({path:project,providerId:'codex',text:'x'})
  await settled(task.id)
  expect(service.detail(task.id).task.error).toBe('something odd happened')
})

const misleadingQuota="You've hit your usage limit. HTTP 429 overloaded"
it.each([
  ['network','provider_network'],
  ['auth_failed','provider_auth_expired'],
  ['auth_rejected','provider_auth_rejected'],
  ['server_error','provider_server_error'],
  ['invalid_request','provider_invalid_request'],
  ['provider_error',misleadingQuota],
  ['network_unprotected','network_unprotected'],
] as const)('authoritative %s does not infer quota from the error text',async(code,taskError)=>{
  next=async()=>failing({kind:'error',message:misleadingQuota,code})
  const task=service.create({path:project,providerId:'codex',text:'x'})
  await settled(task.id)
  expect(service.detail(task.id).task.error).toBe(taskError)
  expect(service.quotaExhausted('codex')).toBeNull()
})

it('uncoded quota text retains the task mapping and quota registration fallback',async()=>{
  next=async()=>failing({kind:'error',message:misleadingQuota})
  const task=service.create({path:project,providerId:'codex',text:'x'})
  await settled(task.id)
  expect(service.detail(task.id).task.error).toBe('provider_quota_exhausted')
  expect(service.quotaExhausted('codex')).toMatchObject({kind:'quota',message:misleadingQuota})
})
