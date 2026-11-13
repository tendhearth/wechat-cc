import {it,expect} from 'vitest'
import {TIER_PROFILES} from '../domain/user-tier'
import {SessionManager} from './session-manager'
import {createProviderRegistry} from './provider-registry'
import {createConversationCoordinator} from './conversation-coordinator'
import {makeReplyDeliveryRuntime} from '../daemon/reply-delivery'
for(const providerId of ['claude','codex','cursor','custom-acp'])for(const chatId of ['visitor','group@chatroom'])it(`${providerId} ${chatId} retains native cold-start prompt behavior`,async()=>{
 const registry=createProviderRegistry(),inputs:string[]=[]
 registry.register(providerId,{spawn:async()=>({resumedHistory:false,resumedHistoryOwnerOnly:true,async *dispatch(text){inputs.push(text);yield {kind:'text',text:'答复'};yield {kind:'result',sessionId:'s',numTurns:1,durationMs:0}},close:async()=>{}})},{displayName:providerId,canResume:()=>true})
 const manager=new SessionManager({registry,maxConcurrent:6,idleEvictMs:60000}),c=createConversationCoordinator({resolveProject:()=>({alias:'p',path:'/tmp/offline'}),manager,registry,conversationStore:{get:()=>null,set:()=>{},setParticipants:()=>{}},defaultProviderId:providerId,permissionMode:'strict',format:m=>m.text,recentTurns:async()=>[{dir:'in',text:'OLD PRIVATE RECENT',ts:'t'}],loadAccess:()=>({dmPolicy:'allowlist',allowFrom:[],admins:[chatId]}),replyDelivery:makeReplyDeliveryRuntime({sendText:async()=>({msgId:'m'}),sleep:async()=>{},log:()=>{}}),log:()=>{}})
 try{if(providerId==='custom-acp'){const h=await manager.acquire({alias:'p',path:'/tmp/offline',providerId,chatId,tierProfile:TIER_PROFILES.trusted,permissionMode:'strict'});expect(h.resumedHistory).toBeUndefined();return}await c.dispatch({accountId:'offline',chatId,userId:chatId,text:'当前入站',msgType:'text',createTimeMs:1});expect(inputs).toEqual(['当前入站'])}finally{await manager.shutdown()}
})
