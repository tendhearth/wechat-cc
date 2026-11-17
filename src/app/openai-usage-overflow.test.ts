import {it,expect} from 'vitest'
import {openTestDb} from '../lib/db'
import {ContextRotation} from './context-rotation'
import {SessionManager} from './session-manager'
import {createProviderRegistry} from './provider-registry'
import {createConversationCoordinator} from './conversation-coordinator'
import {makeReplyDeliveryRuntime} from '../daemon/reply-delivery'
import {createOpenAiAgentProvider} from '../adapters/executors/openai/openai-agent-provider'
import {createApiModel} from '../adapters/executors/openai/api-model'
import {scriptedMcpTools} from '../test-support/executors/openai-scripted'
import {makeCheckupStore} from '../adapters/store/checkup-store'
import {mkdtempSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'

const overflow='litellm.BadRequestError: OpenAIException - Invalid request: Your request exceeded model token limit: 262144 (requested: 319507). Received Model Group=Kimi-Code'
type Reply={text:string}|{error:string;status?:number}
function response(reply:Reply){
  if('error' in reply)return new Response(JSON.stringify({error:{message:reply.error}}),{status:reply.status??400,headers:{'content-type':'application/json'}})
  const chunk={id:'r',object:'chat.completion.chunk',created:1,model:'Kimi-Code',choices:[{index:0,delta:{content:reply.text},finish_reason:'stop'}]}
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}})
}
function rig(replies:Reply[],windowTokens=1000000){
  const db=openTestDb(),dir=mkdtempSync(join(tmpdir(),'openai-overflow-')),registry=createProviderRegistry()
  const bodies:string[]=[],sent:string[]=[],logs:string[]=[],bounds:number[]=[],tools=scriptedMcpTools({tools:[],call:async()=>''})
  const target={provider:'openai',address:'https://offline-rotation.invalid/v1',model:'Kimi-Code',windowTokens,windowKnown:true}
  let spawns=0,at=0
  const provider=createOpenAiAgentProvider({endpoint:{baseUrl:target.address,model:target.model},makeMcpBridge:async()=>tools.bridge,makeBuiltins:()=>[],makeChatModel:()=>createApiModel({baseURL:target.address,apiKey:'offline-fixture',model:target.model,maxRetries:0,fetch:async(_url,init)=>{
    bodies.push(String(init?.body));const next=replies.shift();if(!next)throw Error('unexpected_extra_request');return response(next)
  }})})
  registry.register('openai',{...provider,spawn:async(p,c)=>{spawns++;return provider.spawn(p,c)}},{displayName:'OpenAI',canResume:()=>false})
  const rotation=new ContextRotation({owner:()=> 'owner',load:()=>({sessions:{},chats:{}}),save:()=>{},budgetFor:()=>makeCheckupStore(dir).rotationBudgetFor(target,target.model),recordOverflow:(_k,_m,n)=>{bounds.push(n);makeCheckupStore(dir).recordContextOverflow(target,n)},pending:()=>false,recent:async()=>[{dir:'in',text:'盒子在书房',ts:'2026-11-13T00:00:00Z'}],ongoing:async()=>[],latestTs:async()=> '2026-11-13T00:00:00Z',accounted:async()=>true,extract:async()=>true,defer:()=>{},log:(tag,line)=>logs.push(`${tag} ${line}`)})
  const manager=new SessionManager({registry,contextRotation:rotation,maxConcurrent:6,idleEvictMs:60000})
  const c=createConversationCoordinator({resolveProject:()=>({alias:'p',path:'/tmp/offline'}),manager,registry,contextRotation:rotation,conversationStore:{get:()=>null,set:()=>{},setParticipants:()=>{}},defaultProviderId:'openai',permissionMode:'strict',format:m=>m.text,loadAccess:()=>({dmPolicy:'allowlist',allowFrom:[],admins:['owner']}),sendNotice:async(_c,t)=>{sent.push(t)},replyDelivery:makeReplyDeliveryRuntime({sendText:async(_c,t)=>{sent.push(t);return {msgId:'m'}},sleep:async()=>{},log:()=>{}}),log:()=>{}})
  return {bodies,sent,logs,bounds,rotation,get spawns(){return spawns},budget:()=>makeCheckupStore(dir).rotationBudgetFor(target,target.model),dispatch:(text:string)=>c.dispatch({accountId:'offline',chatId:'owner',userId:'owner',text,msgType:'text',createTimeMs:++at}),close:async()=>{await manager.shutdown();db.close();rmSync(dir,{recursive:true,force:true})}}
}

it('missing usage uses actual request bytes / 3 and rotates OpenAI after eight completed rounds',async()=>{
  const r=rig(Array.from({length:9},()=>({text:'答复'})),8192)
  try{
    for(let n=0;n<8;n++)await r.dispatch('编造长历史'.repeat(1300))
    const last=r.bodies[7]!
    expect(r.rotation.status()[0]).toMatchObject({source:'bytes',estimatedTokens:Math.ceil(Buffer.byteLength(last)/3),fixedOverheadTokens:null})
    await r.dispatch('刚才的盒子在哪')
    expect(r.spawns).toBe(2)
    expect(Buffer.byteLength(r.bodies[8]!)).toBeLessThan(Buffer.byteLength(last))
    expect(r.bodies[8]).toContain('盒子在书房')
    expect(r.rotation.status()[0]?.reason).toBe('budget')
  }finally{await r.close()}
})

for(const failsAgain of [false,true])it(`real LiteLLM rejection rotates and retries one smaller request with continuity (failsAgain=${failsAgain})`,async()=>{
  const r=rig([{text:'第一轮'}, {error:overflow},failsAgain?{error:overflow}:{text:'盒子在书房'}])
  try{
    await r.dispatch('编造历史'.repeat(8000));await r.dispatch('刚才那个在哪')
    expect(r.bodies).toHaveLength(3);expect(r.spawns).toBe(2)
    expect(Buffer.byteLength(r.bodies[2]!)).toBeLessThan(Buffer.byteLength(r.bodies[1]!))
    expect(r.bodies[2]).toContain('盒子在书房');expect(r.bodies[2]).toContain('刚才那个在哪')
    expect(r.sent).toHaveLength(2)
    if(failsAgain)expect(r.sent[1]).toContain('上下文');else expect(r.sent[1]).toBe('盒子在书房')
    expect(r.bounds).toEqual([262144]);expect(r.budget().windowTokens).toBe(262144)
  }finally{await r.close()}
})

it('unrecognized identical growing 4xx failures trip a next-turn fuse without requiring reset',async()=>{
  const r=rig([{error:'vendor opaque rejection (size 100)'},{error:'vendor opaque rejection (size 200)'},{text:'恢复了'}])
  try{
    await r.dispatch('第一轮'.repeat(1500));await r.dispatch('第二轮')
    expect(r.spawns).toBe(1);expect(r.bodies).toHaveLength(2)
    await r.dispatch('再试一次')
    expect(r.spawns).toBe(2);expect(r.bodies).toHaveLength(3)
    expect(Buffer.byteLength(r.bodies[2]!)).toBeLessThan(Buffer.byteLength(r.bodies[1]!))
    expect(r.bodies[2]).toContain('盒子在书房');expect(r.sent.at(-1)).toBe('恢复了')
    expect(r.logs.some(s=>s.includes('reason=failure_fuse'))).toBe(true)
    expect(r.bounds).toEqual([])
  }finally{await r.close()}
})

it('ordinary assistant prose containing the real overflow error never triggers recovery',async()=>{
  const r=rig([{text:overflow},{text:'正常继续'}])
  try{await r.dispatch('解释这条错误');await r.dispatch('继续');expect(r.spawns).toBe(1);expect(r.sent).toEqual([overflow,'正常继续']);expect(r.bounds).toEqual([])}finally{await r.close()}
})
