import {openTestDb} from '../lib/db'
import {makeChatTurnLog} from '../adapters/store/chat-turns'
import {makeMatterStore} from '../adapters/store/matters-store'
import {makeMatterLog} from '../adapters/store/matter-log'
import {it,expect} from 'vitest'
import {ContextRotation} from './context-rotation'
import {SessionManager} from './session-manager'
import {createProviderRegistry} from './provider-registry'
import {createConversationCoordinator} from './conversation-coordinator'
import {makeReplyDeliveryRuntime} from '../daemon/reply-delivery'
import {createOpenAiAgentProvider} from '../adapters/executors/openai/openai-agent-provider'
import {scriptedOpenAiModel,scriptedMcpTools} from '../test-support/executors/openai-scripted'
for(const {failsAgain,spawnFails} of [{failsAgain:false,spawnFails:false},{failsAgain:true,spawnFails:false},{failsAgain:false,spawnFails:true}])it(`real OpenAI overflow retries once before reporting failure (again=${failsAgain}, spawnFails=${spawnFails})`,async()=>{
 const error=()=>Object.assign(new Error('maximum context length is 32000 tokens; requested 33000 tokens'),{statusCode:400,code:'context_length_exceeded'})
 const model=scriptedOpenAiModel([{fail:error()},failsAgain?{fail:error()}:{text:'盒子在书房'}])
 const db=openTestDb(),matters=makeMatterStore(db);matters.ensureChat('owner')
 const registry=createProviderRegistry(),tools=scriptedMcpTools({tools:[],call:async()=>''}),sent:string[]=[],bounds:number[]=[]
 let spawns=0;const codes:(string|undefined)[]=[]
 const provider=createOpenAiAgentProvider({makeChatModel:()=>model.model,makeMcpBridge:async()=>tools.bridge,makeBuiltins:()=>[]})
 registry.register('openai',{...provider,spawn:async(p,c)=>{spawns++;if(spawnFails&&spawns===2)throw Object.assign(new Error('auth rejected'),{providerErrorCode:'auth_rejected'});return provider.spawn(p,c)}},{displayName:'OpenAI',canResume:()=>false})
 const rotation=new ContextRotation({owner:()=> 'owner',load:()=>({sessions:{},chats:{}}),save:()=>{},budgetFor:()=>({windowTokens:32000,reliableFillRatio:.6}),recordOverflow:(_k,_m,n)=>bounds.push(n),pending:()=>true,recent:async()=>[{dir:'in',text:'盒子在书房',ts:'2026-11-13T00:00:00Z'}],ongoing:async()=>[],latestTs:async()=> '2026-11-13T00:00:00Z',accounted:async()=>false,extract:async()=>false,defer:()=>{},log:()=>{}})
 const manager=new SessionManager({registry,contextRotation:rotation,maxConcurrent:6,idleEvictMs:60000})
 const c=createConversationCoordinator({resolveProject:()=>({alias:'p',path:'/tmp/fake'}),manager,registry,contextRotation:rotation,conversationStore:{get:()=>null,set:()=>{},setParticipants:()=>{}},recordTurn:r=>{codes.push(r.errorCode)},chatTurns:makeChatTurnLog({db,log:makeMatterLog(db),matters}),defaultProviderId:'openai',permissionMode:'strict',format:m=>m.text,loadAccess:()=>({dmPolicy:'allowlist',allowFrom:[],admins:['owner']}),sendNotice:async(_c,t)=>{sent.push(t)},replyDelivery:makeReplyDeliveryRuntime({sendText:async(_c,t)=>{sent.push(t);return {msgId:'m'}},sleep:async()=>{},log:()=>{}}),log:()=>{}})
 try{
 await c.dispatch({accountId:'offline',chatId:'owner',userId:'owner',text:'刚才那个在哪',msgType:'text',createTimeMs:1})
 expect(model.seen).toHaveLength(spawnFails?1:2);expect(spawns).toBe(2)
 if(!spawnFails){expect(JSON.stringify(model.seen[1])).toContain('盒子在书房');expect(JSON.stringify(model.seen[1])).toContain('刚才那个在哪')}
 expect(sent).toHaveLength(1)
 if(spawnFails){expect(codes).toEqual(['auth_rejected']);expect(sent[0]).toContain('认证')}
 else if(failsAgain)expect(sent[0]).toContain('上下文');else expect(sent[0]).toBe('盒子在书房')
 expect(db.query('SELECT status FROM matter_turns').all()).toEqual([{status:failsAgain||spawnFails?'failed':'completed'}])
 expect(bounds).toHaveLength(1);expect(bounds[0]).toBeGreaterThan(0)
 }finally{await manager.shutdown();db.close()}
})
