import {it,expect} from 'vitest'
import {openTestDb} from '../lib/db'
import {ContextRotation} from './context-rotation'
import {SessionManager} from './session-manager'
import {createProviderRegistry} from './provider-registry'
import {createConversationCoordinator} from './conversation-coordinator'
import {makeSessionStore} from '../adapters/store/session-store'
import {makeReplyDeliveryRuntime} from '../daemon/reply-delivery'
import type {AgentEvent} from '../ports/agent-provider'

for(const {providerId,crossing} of [{providerId:'claude',crossing:false},{providerId:'claude',crossing:true},{providerId:'openai',crossing:false}])it(`owner continuity: 40 ${providerId} crossing=${crossing} turns with 3 tool calls preserve prior inputs and avoid rotation storms`,async()=>{
 const db=openTestDb(),registry=createProviderRegistry(),jobs:(()=>Promise<void>)[]=[],seen:string[]=[],raw:string[]=[],segments=new Map<string,string[]>(),rotationTurns:number[]=[]
 let turn=0,spawns=0,lastTokens=0,first=0,segmentTurns=0
 registry.register(providerId,{spawn:async(_p,ctx)=>{
  const id=ctx.resumeSessionId??`native-${++spawns}`,history=segments.get(id)??[];segments.set(id,history);segmentTurns=0
  return {resumedHistory:!!ctx.resumeSessionId,contextUsage:()=>({historyBytes:0,tokens:lastTokens,firstInputTokens:first,model:'actual'}),async *dispatch(text:string){
   turn++;segmentTurns++;raw.push(text);history.push(text);seen.push(history.join('\n'));lastTokens=providerId==='claude'?(crossing?40000+segmentTurns*6000:60000+turn*400):12000+segmentTurns*2200;if(segmentTurns===1)first=lastTokens
   for(let i=0;i<3;i++)yield {kind:'tool_call',tool:`Read${i}`} as AgentEvent
   yield {kind:'text',text:`回复${turn}`};yield {kind:'result',sessionId:id,numTurns:4,durationMs:1,usage:{input:900000,output:900000}}
  },close:async()=>{}}
 }},{displayName:providerId,canResume:()=>true})
 const rotation=new ContextRotation({owner:()=> 'owner',load:()=>({sessions:{},chats:{}}),save:()=>{},budgetFor:()=>({windowTokens:providerId==='claude'?200000:32000,reliableFillRatio:.6}),pending:()=>false,recent:async()=>Array.from({length:Math.min(turn,6)},(_,i)=>({dir:'in' as const,text:`问题${turn-Math.min(turn,6)+i+1}`,ts:'2026-11-13T00:00:00Z'})),ongoing:async()=>[],latestTs:async()=> '2026-11-13T00:00:00Z',accounted:async()=>true,extract:async()=>true,defer:j=>jobs.push(j),log:(tag)=>{if(tag==='CONTEXT_ROTATE')rotationTurns.push(turn)}})
 const manager=new SessionManager({registry,contextRotation:rotation,sessionStore:makeSessionStore(db),maxConcurrent:6,idleEvictMs:60000,buildInstructions:()=> '系统'.repeat(20000)})
 const c=createConversationCoordinator({resolveProject:()=>({alias:'p',path:'/tmp/fake'}),manager,registry,contextRotation:rotation,conversationStore:{get:()=>null,set:()=>{},setParticipants:()=>{}},defaultProviderId:providerId,permissionMode:'strict',format:m=>m.text,loadAccess:()=>({dmPolicy:'allowlist',allowFrom:[],admins:['owner']}),replyDelivery:makeReplyDeliveryRuntime({sendText:async()=>({msgId:'m'}),sleep:async()=>{},log:()=>{}}),log:()=>{}})
 try{
  for(let i=1;i<=40;i++){
   if(i===30)rotation.noteCompanion('owner','我刚才建议去河边喝茶。')
   await c.dispatch({accountId:'offline',chatId:'owner',userId:'owner',text:`问题${i}`,msgType:'text',createTimeMs:i})
   if(i===20&&providerId==='claude'&&!crossing)await manager.release({alias:'p',providerId,chatId:'owner'})
   while(jobs.length)await jobs.shift()!()
   if(providerId==='openai'){expect(rotation.status()[0]!.estimatedTokens).toBeLessThanOrEqual(32000);expect(rotation.status()[0]!.budgetTokens).toBeLessThanOrEqual(27200)}
   if(i>1)expect(seen[i-1]).toContain(`问题${i-1}`)
  }
  if(crossing){expect(rotationTurns).toEqual([14,28]);expect(spawns).toBe(3);expect(raw[14]).toContain('问题14');expect(raw[28]).toContain('问题28')}
  else if(providerId==='claude'){expect(rotationTurns).toEqual([]);expect(spawns).toBe(1);expect(raw[20]).not.toContain('<handoff');expect(raw[29]).toContain('我刚才建议去河边喝茶。')}
  else {expect(rotationTurns).toEqual([8,16,24,32]);expect(rotationTurns.length).toBeGreaterThan(0);expect(rotationTurns.length).toBeLessThanOrEqual(5);for(let i=1;i<rotationTurns.length;i++)expect(rotationTurns[i]!-rotationTurns[i-1]!).toBeGreaterThanOrEqual(8)}
 }finally{await manager.shutdown();db.close()}
})
it('owner continuity: the dispatch that discovers a native window persists it before any later turn',async()=>{
 const {mkdtempSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path')
 const {makeCheckupStore}=await import('../adapters/store/checkup-store')
 const {TIER_PROFILES}=await import('../domain/user-tier')
 const db=openTestDb(),dir=mkdtempSync(join(tmpdir(),'rotation-capacity-')),registry=createProviderRegistry()
 let window:number|undefined
 const target={provider:'claude',address:'https://endpoint.invalid',model:'native',windowTokens:32000,windowKnown:false}
 registry.register('claude',{contextWindowTokens:()=>window,spawn:async()=>({contextUsage:()=>({historyBytes:0,tokens:60000,firstInputTokens:40000,model:'native'}),async *dispatch(){window=200000;yield {kind:'result',sessionId:'s',numTurns:1,durationMs:0}},close:async()=>{}})},{displayName:'Claude',canResume:()=>true})
 const rotation=new ContextRotation({owner:()=> 'owner',load:()=>({sessions:{},chats:{}}),save:()=>{},budgetFor:(_p,model)=>makeCheckupStore(dir).rotationBudgetFor({...target,model,windowTokens:window??32000,windowKnown:window!==undefined},model),pending:()=>false,recent:async()=>[],ongoing:async()=>[],latestTs:async()=>null,accounted:async()=>true,extract:async()=>true,defer:()=>{},log:()=>{}})
 const manager=new SessionManager({registry,contextRotation:rotation,maxConcurrent:6,idleEvictMs:60000}),key={providerId:'claude',alias:'p',chatId:'owner'}
 try{
  await rotation.beforeTurn(key,'default',manager)
  const handle=await manager.acquire({...key,path:'/tmp/fake',tierProfile:TIER_PROFILES.admin,permissionMode:'strict'})
  for await(const _ of handle.dispatch('聊天')){/* request reports native window */}
  window=undefined
  expect(makeCheckupStore(dir).rotationBudgetFor(target,'native')).toMatchObject({windowTokens:200000,windowSource:'persisted'})
 }finally{await manager.shutdown();db.close();rmSync(dir,{recursive:true,force:true})}
})
