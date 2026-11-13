import { it,expect } from 'vitest'
import { makeTickDispatch } from './tick-dispatch'
import { SessionManager } from '../../app/session-manager'
import { createProviderRegistry } from '../../app/provider-registry'
import { TIER_PROFILES } from '../../domain/user-tier'
import { makeProactiveOutbound } from '../../daemon/companion/proactive-channel'
import { makeReplyDeliveryRuntime } from '../../daemon/reply-delivery'
import { openTestDb } from '../../lib/db'
import type { TickDeps } from './tick-deps'

it('companion ticks use short isolated sessions while owner history and outgoing delivery stay intact',async()=>{
  const db=openTestDb(),registry=createProviderRegistry(),history=new Map<string,string[]>(),notes:string[]=[],sent:string[]=[],closed:string[]=[],models:(string|undefined)[]=[]
  registry.register('claude',{spawn:async (project,ctx)=>{models.push(ctx.model);return ({async *dispatch(text){const rows=history.get(project.alias)??[];rows.push(text);history.set(project.alias,rows);yield {kind:'text',text:'陪伴的完整正文\n'.repeat(40)};yield {kind:'result',sessionId:project.alias,numTurns:1,durationMs:1}},close:async()=>{closed.push(project.alias)}})}},{displayName:'Claude',canResume:()=>true})
  const manager=new SessionManager({registry,maxConcurrent:6,idleEvictMs:60_000})
  const owner=await manager.acquire({alias:'_default',path:'/tmp',providerId:'claude',chatId:'owner',tierProfile:TIER_PROFILES.admin,permissionMode:'strict'})
  for await(const _ of owner.dispatch('主人原文')){/* drain */}
  const outgoing=makeProactiveOutbound({wechatDegraded:()=>false,wechatClosedSince:()=>null,sendWechat:async(_c,t)=>{sent.push(t);return {msgId:'m'}},app:()=>null,log:()=>{}})
  const tick=makeTickDispatch({db,stateDir:'/tmp/no-real-state',projects:{load:()=>({projects:{},current:null})},boot:{sessionManager:manager,defaultProviderId:'claude',coordinator:{getMode:()=>({kind:'solo',provider:'claude',model:'owner-pin'}),runExclusive:async(_c:string,fn:()=>Promise<void>)=>fn()},contextRotation:{isOwnerChat:(c:string)=>c==='owner',continuation:async()=>({block:'最近主人说过的原文\n在办：整理相册',carried:1}),noteCompanion:(_c:string,line:string)=>notes.push(line)}},loadAccess:()=>({dmPolicy:'allowlist',allowFrom:[],admins:['owner']}),permissionMode:'strict',speech:{},replyDelivery:makeReplyDeliveryRuntime({sendText:async()=>({msgId:'unused'}),sleep:async()=>{},log:()=>{}}),log:()=>{}} as unknown as TickDeps)
  try{
    await tick.dispatchToChat('owner',{claim:()=>{},buildText:()=> '陪伴内部定时提示',summary:'提醒主人去散步',outbound:outgoing.open('owner')})
    expect(history.get('_default')).toEqual(['主人原文'])
    expect([...history.keys()].filter(k=>k.startsWith('companion:'))).toHaveLength(1)
    expect(closed.some(k=>k.startsWith('companion:'))).toBe(true)
    expect(sent.join('')).toContain('陪伴的完整正文')
    expect(notes).toEqual(['陪伴的完整正文\n'.repeat(40)])
    expect([...history.values()].flat().join('')).toContain('最近主人说过的原文')
    expect([...history.values()].flat().join('')).toContain('在办：整理相册')
    expect(manager.list()).toHaveLength(1)
    expect(models).toEqual([undefined,'owner-pin'])
  }finally{await manager.shutdown();db.close()}
})

for(const chatId of ['visitor','group@chatroom','owner'])it(`owner continuity: ${chatId} keeps its session lifecycle when preparing a tick`,async()=>{
 const db=openTestDb(),registry=createProviderRegistry(),inputs:{alias:string;text:string;ephemeral:boolean}[]=[]
 let claims=0,spawns=0
 registry.register('claude',{spawn:async(p,ctx)=>{spawns++;return {async *dispatch(text){inputs.push({alias:p.alias,text,ephemeral:ctx.ephemeral??false});yield {kind:'text',text:'说给你听'};yield {kind:'result',sessionId:'s',numTurns:1,durationMs:0}},close:async()=>{}}}},{displayName:'Claude',canResume:()=>true})
 const manager=new SessionManager({registry,maxConcurrent:6,idleEvictMs:60000})
 const outbound=makeProactiveOutbound({wechatDegraded:()=>false,wechatClosedSince:()=>null,sendWechat:async()=>({msgId:'m'}),app:()=>null,log:()=>{}})
 const tick=makeTickDispatch({db,stateDir:'/tmp/no-real-state',projects:{load:()=>({projects:{},current:null})},boot:{sessionManager:manager,defaultProviderId:'claude',coordinator:{getMode:()=>({kind:'solo',provider:'claude'}),runExclusive:async(_c:string,fn:()=>Promise<void>)=>fn()},contextRotation:{isOwnerChat:(c:string)=>c==='owner',continuation:async()=>{throw Error('offline context read')},noteCompanion:()=>{}}},loadAccess:()=>({dmPolicy:'allowlist',allowFrom:[],admins:['owner',chatId]}),permissionMode:'strict',speech:{},replyDelivery:makeReplyDeliveryRuntime({sendText:async()=>({msgId:'m'}),sleep:async()=>{},log:()=>{}}),log:()=>{}} as unknown as TickDeps)
 try{
  const work=tick.dispatchToChat(chatId,{claim:()=>{claims++},buildText:()=> '定时提示',outbound:outbound.open(chatId)})
  if(chatId==='owner'){await expect(work).rejects.toThrow('offline context read');expect(spawns).toBe(0);expect(claims).toBe(0);expect(manager.list()).toHaveLength(0)}
  else {await work;expect(inputs).toEqual([{alias:'_default',text:'定时提示',ephemeral:false}]);expect(manager.list()).toHaveLength(1);expect(claims).toBe(1)}
 }finally{await manager.shutdown();db.close()}
})
