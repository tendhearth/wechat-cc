import { describe, it, expect } from 'vitest'
import { ContextRotation } from './context-rotation'
import { SessionManager } from './session-manager'
import { createProviderRegistry } from './provider-registry'
import { createConversationCoordinator } from './conversation-coordinator'
import { makeReplyDeliveryRuntime } from '../daemon/reply-delivery'
import { makeSessionStore } from '../adapters/store/session-store'
import { openTestDb } from '../lib/db'
import type { AgentProvider, AgentEvent } from '../ports/agent-provider'
import { TIER_PROFILES } from '../domain/user-tier'
import { createOpenAiAgentProvider } from '../adapters/executors/openai/openai-agent-provider'
import { scriptedOpenAiModel, scriptedMcpTools } from '../test-support/executors/openai-scripted'

for(const providerId of ['claude','openai','gemini'])describe(`${providerId} real coordinator/manager rotation`,()=>{
  it('replaces an over-budget session before the next turn and continues the previous raw words without a notice',async()=>{
    const db=openTestDb(),registry=createProviderRegistry(),inputs:{session:number;text:string}[]=[],out:string[]=[],jobs:(()=>Promise<void>)[]=[]
    let spawned=0,closed=0
    const provider:AgentProvider={spawn:async()=>{const session=++spawned;return {resumedHistory:false,contextUsage:()=>({historyBytes:120000,tokens:60000,firstInputTokens:1000}),async *dispatch(text:string){inputs.push({session,text});yield {kind:'text',text:'上轮答复'+ '答'.repeat(800)};yield {kind:'result',sessionId:`s${session}`,numTurns:1,durationMs:0}},close:async()=>{closed++}}}}
    registry.register(providerId,provider,{displayName:providerId,canResume:()=>providerId!=='gemini'})
    const rotation=new ContextRotation({owner:()=> 'owner',load:()=>({sessions:{},chats:{}}),save:()=>{},minBudgetTurns:1,budgetFor:()=>({windowTokens:2000,reliableFillRatio:.5}),pending:()=>false,recent:async()=>[{dir:'in',text:'刚才那个盒子放在书房',ts:'2026-11-12T20:00:00Z'},{dir:'out',text:'记下了，盒子在书房',ts:'2026-11-12T20:00:01Z'}],ongoing:async()=>['相册：正在校对'],latestTs:async()=> '2026-11-12T20:00:01Z',accounted:async()=>true,extract:async()=>true,defer:job=>jobs.push(job),log:()=>{}})
    const manager=new SessionManager({maxConcurrent:6,idleEvictMs:60_000,registry,sessionStore:makeSessionStore(db),contextRotation:rotation})
    const coordinator=createConversationCoordinator({resolveProject:()=>({alias:'proj',path:'/tmp/fake'}),manager,registry,contextRotation:rotation,conversationStore:{get:()=>null,set:()=>{},setParticipants:()=>{}},defaultProviderId:providerId,permissionMode:'strict',format:m=>m.text,loadAccess:()=>({dmPolicy:'allowlist',allowFrom:[],admins:['owner']}),replyDelivery:makeReplyDeliveryRuntime({sendText:async(_c,t)=>{out.push(t);return {msgId:'m'}},sleep:async()=>{},log:()=>{}}),log:()=>{}})
    const msg=(text:string,at:number)=>({accountId:'test-account',chatId:'owner',userId:'owner',text,msgType:'text' as const,createTimeMs:at})
    try{
      await coordinator.dispatch(msg('刚才那个盒子放在书房',1));await jobs.shift()?.()
      await coordinator.dispatch(msg('刚才那个在哪',2))
      expect(spawned).toBe(2);expect(closed).toBe(1)
      expect(inputs[1]!.session).toBe(2)
      expect(inputs[1]!.text).toContain('刚才那个盒子放在书房')
      expect(inputs[1]!.text).toContain('相册：正在校对')
      expect(inputs[1]!.text.endsWith('刚才那个在哪')).toBe(true)
      expect(out).toHaveLength(2)
      expect(rotation.status()[0]!.reason).toBe('budget')
    }finally{await manager.shutdown();db.close()}
  })
})

it('SessionManager refuses rotation while a tool/approval keeps its dispatch iterator open',async()=>{
  const registry=createProviderRegistry();let finish!:()=>void,entered!:()=>void,closed=false
  const blocked=new Promise<void>(r=>{finish=r}),ready=new Promise<void>(r=>{entered=r})
  registry.register('claude',{spawn:async()=>({async *dispatch(){entered();await blocked;yield {kind:'result' as const,sessionId:'s',numTurns:1,durationMs:1}},close:async()=>{closed=true}})},{displayName:'Claude',canResume:()=>true})
  const manager=new SessionManager({registry,maxConcurrent:6,idleEvictMs:1})
  const key={alias:'p',providerId:'claude',chatId:'owner'},handle=await manager.acquire({...key,path:'/tmp',tierProfile:TIER_PROFILES.admin,permissionMode:'strict'})
  const drain=(async()=>{for await(const _ of handle.dispatch('go')){/* wait */}})();await ready
  try{expect(await manager.rotate(key)).toBe(false);expect(closed).toBe(false)}finally{finish();await drain;await manager.shutdown()}
})

it('owner continuity: a failed OpenAI request keeps tool history without speculative rotation',async()=>{
  const db=openTestDb(),registry=createProviderRegistry(),jobs:(()=>Promise<void>)[]=[]
  const model=scriptedOpenAiModel([{calls:[{id:'t',name:'lookup'}],usage:{input:10,output:2}},{fail:new Error('offline endpoint')},{text:'下轮答复'}])
  const tools=scriptedMcpTools({tools:[{name:'lookup',server:'wechat'}],call:async()=> '工具正文'.repeat(3000)})
  const provider=createOpenAiAgentProvider({makeChatModel:()=>model.model,makeMcpBridge:async()=>tools.bridge,makeBuiltins:()=>[]})
  registry.register('openai',provider,{displayName:'OpenAI',canResume:()=>false})
  const rotation=new ContextRotation({owner:()=> 'owner',load:()=>({sessions:{},chats:{}}),save:()=>{},budgetFor:()=>({windowTokens:4000,reliableFillRatio:.5}),pending:()=>false,recent:async()=>[{dir:'in',text:'刚才查的盒子',ts:'2026-11-12T00:00:00Z'}],ongoing:async()=>[],latestTs:async()=> '2026-11-12T00:00:00Z',accounted:async()=>true,extract:async()=>true,defer:j=>jobs.push(j),log:()=>{}})
  const manager=new SessionManager({registry,maxConcurrent:6,idleEvictMs:1,contextRotation:rotation})
  const key={alias:'p',providerId:'openai',chatId:'owner'},req={...key,path:'/tmp',tierProfile:TIER_PROFILES.admin,permissionMode:'strict' as const}
  try{
    await rotation.beforeTurn(key,'m',manager)
    const first=await manager.acquire(req);const events:AgentEvent[]=[];for await(const e of first.dispatch('查一查'))events.push(e)
    expect(events.at(-1)?.kind).toBe('error')
    expect(rotation.status()[0]!.estimatedTokens).toBeGreaterThan(2000)
    expect(rotation.status()[0]!.source).toBe('bytes')
    const carry=await rotation.beforeTurn(key,'m',manager)
    const next=await manager.acquire(req);for await(const _ of next.dispatch(`${carry?.block}\n再说一次`)){/* drain */}
    expect(carry).toBeNull()
    expect(JSON.stringify(model.seen[2])).toContain('工具正文')
    expect(JSON.stringify(model.seen[2])).toContain('再说一次')
  }finally{await manager.shutdown();db.close()}
})

it('owner continuity: unreported native tools do not reserve imaginary context',async()=>{
  const registry=createProviderRegistry(),key={alias:'p',providerId:'cursor',chatId:'owner'}
  registry.register('cursor',{spawn:async()=>({async *dispatch(){yield {kind:'tool_call',tool:'large_read'};yield {kind:'text',text:'完成'};yield {kind:'result',sessionId:'s',numTurns:1,durationMs:0}},close:async()=>{}})},{displayName:'Cursor',canResume:()=>true})
  const rotation=new ContextRotation({owner:()=> 'owner',load:()=>({sessions:{},chats:{}}),save:()=>{},budgetFor:()=>({windowTokens:8192,reliableFillRatio:.25}),pending:()=>false,recent:async()=>[],ongoing:async()=>[],latestTs:async()=> '2026-11-12T20:00:00Z',accounted:async()=>true,extract:async()=>true,defer:()=>{},log:()=>{}})
  const manager=new SessionManager({registry,maxConcurrent:6,idleEvictMs:1,contextRotation:rotation})
  try{
    await rotation.beforeTurn(key,'m',manager)
    const handle=await manager.acquire({...key,path:'/tmp',tierProfile:TIER_PROFILES.admin,permissionMode:'strict'})
    for await(const _ of handle.dispatch('读文件')){/* drain */}
    expect(rotation.status()[0]!.estimatedTokens).toBeLessThan(2048)
    await rotation.beforeTurn(key,'m',manager)
    expect(rotation.status()[0]!.reason).toBeNull()
  }finally{await manager.shutdown()}
})

it('a valid Claude resume is consistently exposed as resumed history',async()=>{
 const db=openTestDb(),registry=createProviderRegistry(),store=makeSessionStore(db),key={alias:'p',providerId:'claude',chatId:'owner'}
 registry.register('claude',{spawn:async()=>({async *dispatch(){yield {kind:'result',sessionId:'s',numTurns:1,durationMs:0}},close:async()=>{}})},{displayName:'Claude',canResume:()=>true})
 store.set({alias:'p',provider:'claude',chatId:'owner',sessionId:'unconfirmed-old'})
 const rotation=new ContextRotation({owner:()=> 'owner',load:()=>({sessions:{},chats:{}}),save:()=>{},budgetFor:()=>({windowTokens:8192,reliableFillRatio:.25}),pending:()=>false,recent:async()=>[],ongoing:async()=>[],latestTs:async()=>null,accounted:async()=>true,extract:async()=>true,defer:()=>{},log:()=>{}})
 const manager=new SessionManager({registry,sessionStore:store,contextRotation:rotation,maxConcurrent:6,idleEvictMs:1})
 try{
  await rotation.beforeTurn(key,'m',manager)
  const handle=await manager.acquire({...key,path:'/tmp',tierProfile:TIER_PROFILES.admin,permissionMode:'strict'})
  expect(handle.resumedHistory).toBe(true)
 }finally{await manager.shutdown();db.close()}
})
it('owner continuity: native missing request usage is unknown through SessionManager, rather than a fabricated zero',async()=>{
 const registry=createProviderRegistry(),key={alias:'p',providerId:'claude',chatId:'owner'}
 let calls=0
 registry.register('claude',{spawn:async()=>({contextUsage:()=>calls===1?{tokens:40000,firstInputTokens:40000}:{firstInputTokens:40000},async *dispatch(){calls++;yield {kind:'result',sessionId:'s',numTurns:1,durationMs:0}},close:async()=>{}})},{displayName:'Claude',canResume:()=>true})
 const rotation=new ContextRotation({owner:()=> 'owner',load:()=>({sessions:{},chats:{}}),save:()=>{},budgetFor:()=>({windowTokens:200000,reliableFillRatio:.6}),pending:()=>false,recent:async()=>[],ongoing:async()=>[],latestTs:async()=>null,accounted:async()=>true,extract:async()=>true,defer:()=>{},log:()=>{}})
 const manager=new SessionManager({registry,contextRotation:rotation,maxConcurrent:6,idleEvictMs:60000})
 try{
  await rotation.beforeTurn(key,'m',manager)
  const handle=await manager.acquire({...key,path:'/tmp',tierProfile:TIER_PROFILES.admin,permissionMode:'strict'})
  for await(const _ of handle.dispatch('第一句')){/* measured request */}
  expect(rotation.status()[0]).toMatchObject({source:'provider',estimatedTokens:40000})
  for await(const _ of handle.dispatch('接着聊')){/* unmeasured request */}
  expect(rotation.status()[0]).toMatchObject({source:'unknown',fixedOverheadTokens:40000})
  expect(await rotation.beforeTurn(key,'m',manager)).toBeNull()
 }finally{await manager.shutdown()}
})
